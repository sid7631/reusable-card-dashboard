"""Typed specs stored in AssetVersion.spec, one per asset kind.

Specs reference other assets by (asset_id, version_id) so a version is a complete, reproducible
snapshot: a dashboard version pins card versions, a card version pins a data-source version.
"""

from typing import Annotated, Any, Literal, Union
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

ChartType = Literal["kpi", "barlist", "bar", "column", "line", "area", "donut", "table"]


class AssetRef(BaseModel):
    asset_id: int
    version_id: int


# ---------------------------------------------------------------- data source
class PostgresConnection(BaseModel):
    # Any field may be "env:NAME" — resolved from the API's environment at connect time, which keeps
    # deployment-specific hosts out of versioned specs (admin-only). `secret_ref` is "sec:<id>" for
    # credentials stored encrypted in the secrets table.
    host: str
    port: int | str = 5432
    database: str
    user: str
    secret_ref: str | None = None


class RestAuth(BaseModel):
    type: Literal["none", "bearer", "api_key", "basic"] = "none"
    header: str = "X-API-Key"   # api_key: header carrying the key
    username: str = ""          # basic
    secret_ref: str | None = None


class RestPagination(BaseModel):
    type: Literal["none", "page"] = "none"
    page_param: str = "page"
    size_param: str | None = None
    page_size: int = Field(100, ge=1, le=10_000)
    max_pages: int = Field(20, ge=1, le=500)


class RestConfig(BaseModel):
    url: str = Field(pattern=r"^https?://")
    headers: dict[str, str] = Field(default_factory=dict)
    query: dict[str, str] = Field(default_factory=dict)
    auth: RestAuth = Field(default_factory=RestAuth)
    # Dot path to the record list in the response, e.g. "data.items"; empty = response root
    records_path: str = ""
    pagination: RestPagination = Field(default_factory=RestPagination)
    table: str = Field("records", pattern=r"^[a-z_][a-z0-9_]{0,62}$")


class FileConfig(BaseModel):
    file_id: int


class ExecutionPolicy(BaseModel):
    max_concurrency: int = Field(5, ge=1, le=100)
    timeout_s: float = Field(30, gt=0, le=300)
    # Result cache TTL; for REST sources also how long an extract stays fresh before re-fetching
    cache_ttl_s: int = Field(900, ge=0)


class Dimension(BaseModel):
    name: str
    column: str
    type: Literal["string", "number", "date", "boolean"] = "string"
    label: str = ""
    description: str = ""


class Measure(BaseModel):
    name: str
    expr: str                    # aggregate SQL expression, e.g. SUM(amount)
    label: str = ""
    description: str = ""
    format: Literal["number", "currency", "percent"] = "number"


class SemanticDataset(BaseModel):
    """Business view of one table — names, descriptions and roles that the builder, filters
    and (later) LLM tools work with instead of raw columns."""
    name: str                    # physical table
    label: str = ""
    description: str = ""
    time_dimension: str | None = None
    dimensions: list[Dimension] = Field(default_factory=list)
    measures: list[Measure] = Field(default_factory=list)


class SemanticModel(BaseModel):
    datasets: list[SemanticDataset] = Field(default_factory=list)


class DataSourceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["postgres", "rest", "file"]
    connection: PostgresConnection | None = None
    rest: RestConfig | None = None
    file: FileConfig | None = None
    execution: ExecutionPolicy = Field(default_factory=ExecutionPolicy)
    model: SemanticModel = Field(default_factory=SemanticModel)

    @model_validator(mode="before")
    @classmethod
    def _upgrade_legacy(cls, data: Any) -> Any:
        # Phase-0 specs listed `tables` + `dimensions` instead of a semantic model
        if isinstance(data, dict) and ("tables" in data or "dimensions" in data):
            data = dict(data)
            tables, dims = data.pop("tables", []), data.pop("dimensions", [])
            data.setdefault("model", {"datasets": [
                {"name": t, "dimensions": [{"name": d, "column": d} for d in dims]} for t in tables]})
        return data

    @model_validator(mode="after")
    def _section_matches_type(self) -> "DataSourceSpec":
        section = {"postgres": self.connection, "rest": self.rest, "file": self.file}[self.type]
        if section is None:
            raise ValueError(f"A {self.type} source needs its `{ {'postgres': 'connection'}.get(self.type, self.type)}` settings.")
        return self

    @property
    def dialect(self) -> str:
        return "postgres" if self.type == "postgres" else "duckdb"

    def secret_refs(self) -> list[str]:
        refs = [self.connection.secret_ref if self.connection else None,
                self.rest.auth.secret_ref if self.rest else None]
        return [r for r in refs if r]

    def endpoint(self) -> tuple[Any, ...]:
        """Where credentials are sent — a secret may only be reused against the same endpoint."""
        if self.connection:
            c = self.connection
            return ("postgres", c.host, str(c.port), c.database, c.user)
        if self.rest:
            from urllib.parse import urlsplit
            u = urlsplit(self.rest.url)
            return ("rest", u.scheme, u.netloc, self.rest.auth.type, self.rest.auth.header, self.rest.auth.username)
        return ("file", self.file.file_id if self.file else None)


# ---------------------------------------------------------------- card
class SqlQuery(BaseModel):
    mode: Literal["sql"] = "sql"
    # One read-only SELECT; `{{filters}}` is replaced by bound dashboard/card filter conditions
    sql: str


class CardSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chart_type: ChartType
    data_source: AssetRef
    # Raw SQL, or a semantic query (measures × dimensions) compiled per dialect
    query: Annotated[Union[SqlQuery, "SemanticQuery"], Field(discriminator="mode")]
    created_via: Literal["builder", "sql", "copilot"] = "builder"
    # Builder state + visual options (axis mapping, scheme, on-card controls); opaque to the server
    config: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------- dashboard
class DashboardItem(BaseModel):
    # Stable id so three-way merges can match items across versions (architecture §4.6)
    item_id: str = Field(default_factory=lambda: uuid4().hex)
    card: AssetRef
    x: int = 0
    y: int = 0
    w: int = Field(4, ge=1, le=12)
    h: int = Field(4, ge=1)


class DashboardFilter(BaseModel):
    """A dashboard filter control bound to a semantic dimension (architecture §7)."""
    id: str = Field(pattern=r"^[a-z0-9_-]{1,40}$")
    kind: Literal["select", "multi", "period"] = "select"
    dimension: str = ""                  # ignored for kind=period (binds to each dataset's time dimension)
    label: str = ""
    parent: str | None = None            # cascading: options narrow to the parent's selection
    source_id: int | None = None         # where options come from; default: first card source with the dimension
    default: list[str] = Field(default_factory=list)   # period: [preset id]
    locked: bool = False                 # cards may not override a locked filter


class DashboardSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[DashboardItem] = Field(default_factory=list)
    filters: list[DashboardFilter] = Field(default_factory=list)

    @model_validator(mode="after")
    def _valid_filters(self) -> "DashboardSpec":
        ids = [f.id for f in self.filters]
        if len(ids) != len(set(ids)):
            raise ValueError("Filter ids must be unique.")
        for f in self.filters:
            if f.parent is not None and (f.parent not in ids or f.parent == f.id):
                raise ValueError(f"Filter “{f.id}” has an unknown parent.")
            if f.kind != "period" and not f.dimension:
                raise ValueError(f"Filter “{f.id}” needs a dimension.")
        # parents must not form a cycle
        parent = {f.id: f.parent for f in self.filters}
        for f in self.filters:
            seen, cur = set(), f.id
            while cur is not None:
                if cur in seen:
                    raise ValueError("Filter parents form a cycle.")
                seen.add(cur)
                cur = parent.get(cur)
        return self


SPEC_MODELS: dict[str, type[BaseModel]] = {
    "data_source": DataSourceSpec,
    "card": CardSpec,
    "dashboard": DashboardSpec,
}


def dependencies(kind: str, spec: BaseModel) -> list[AssetRef]:
    if isinstance(spec, CardSpec):
        return [spec.data_source]
    if isinstance(spec, DashboardSpec):
        return [item.card for item in spec.items]
    return []


from app.semantic.query import SemanticQuery  # noqa: E402 — imports this module's SemanticDataset

CardSpec.model_rebuild()
