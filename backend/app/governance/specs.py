"""Typed specs stored in AssetVersion.spec, one per asset kind.

Specs reference other assets by (asset_id, version_id) so a version is a complete, reproducible
snapshot: a dashboard version pins card versions, a card version pins a data-source version.
"""

from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

ChartType = Literal["kpi", "barlist", "bar", "column", "line", "area", "donut", "table"]


class AssetRef(BaseModel):
    asset_id: int
    version_id: int


# ---------------------------------------------------------------- data source
class PostgresConnection(BaseModel):
    # Any field may be "env:NAME" — resolved from the API's environment at connect time, which keeps
    # deployment-specific hosts out of versioned specs. Encrypted stored secrets arrive in phase 3.
    host: str
    port: int | str = 5432
    database: str
    user: str
    secret_ref: str


class ExecutionPolicy(BaseModel):
    max_concurrency: int = 5
    timeout_s: float = 30
    cache_ttl_s: int = 900


class DataSourceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["postgres"]
    connection: PostgresConnection
    execution: ExecutionPolicy = Field(default_factory=ExecutionPolicy)
    # Tables the source exposes, plus filterable dimensions — becomes the full semantic model in phase 4
    tables: list[str] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------- card
class SqlQuery(BaseModel):
    mode: Literal["sql"] = "sql"
    # One read-only SELECT; `{{filters}}` is replaced by bound dashboard/card filter conditions
    sql: str


class CardSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chart_type: ChartType
    data_source: AssetRef
    query: SqlQuery
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


class DashboardSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[DashboardItem] = Field(default_factory=list)
    # Filter controls (hierarchy + override levels) arrive in phase 4
    filters: list[dict[str, Any]] = Field(default_factory=list)


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
