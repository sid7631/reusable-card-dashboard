"""Semantic card queries: measures by dimensions, in business terms, compiled to dialect SQL.

The same compiled path serves the card builder now and LLM tool calls later (architecture §9):
callers name measures and dimensions from the source's semantic model, never raw SQL.
"""

from typing import Any, Literal

import sqlglot
from pydantic import BaseModel, Field, model_validator
from sqlglot import exp
from sqlglot.errors import ParseError

from app.governance.specs import DataSourceSpec, SemanticDataset
from app.semantic.filters import Filters, FilterError, bind, quote

Grain = Literal["day", "week", "month", "quarter", "year"]
AGGS = ("SUM", "AVG", "COUNT", "MIN", "MAX", "COUNT_DISTINCT")


class MeasureRef(BaseModel):
    """A measure from the model by name, or an ad-hoc aggregate of a column."""
    name: str | None = None
    agg: Literal["SUM", "AVG", "COUNT", "MIN", "MAX", "COUNT_DISTINCT"] | None = None
    column: str | None = None
    label: str | None = None

    @model_validator(mode="after")
    def _one_kind(self) -> "MeasureRef":
        if bool(self.name) == bool(self.agg):
            raise ValueError("A measure is either a model measure `name` or an `agg` (+ `column`).")
        if self.agg and self.agg != "COUNT" and not self.column:
            raise ValueError(f"{self.agg} needs a column.")
        return self


class DimensionRef(BaseModel):
    name: str
    grain: Grain | None = None   # time dimensions only


class StaticFilter(BaseModel):
    dimension: str
    values: list[str] = Field(min_length=1)


class SemanticQuery(BaseModel):
    mode: Literal["semantic"] = "semantic"
    dataset: str
    measures: list[MeasureRef] = Field(min_length=1, max_length=6)
    dimensions: list[DimensionRef] = Field(default_factory=list, max_length=2)
    filters: list[StaticFilter] = Field(default_factory=list)
    order: Literal["value_desc", "value_asc", "label_asc", "label_desc"] | None = None
    limit: int | None = Field(None, ge=1, le=10_000)


class CompileError(ValueError):
    pass


def _dataset(source: DataSourceSpec, name: str) -> SemanticDataset:
    for d in source.model.datasets:
        if d.name == name:
            return d
    raise CompileError(f"Dataset “{name}” is not in this source's model.")


_FORBIDDEN = (exp.Query, exp.Subquery, exp.Insert, exp.Update, exp.Delete, exp.Command, exp.Create, exp.Drop)


def _measure_sql(expr: str, dialect: str) -> str:
    """Model measures are aggregate expressions written by the source owner; reject anything else."""
    try:
        node = sqlglot.parse_one(expr, dialect=dialect)
    except ParseError as exc:
        raise CompileError(f"Invalid measure expression “{expr}”.") from exc
    if isinstance(node, _FORBIDDEN) or any(node.find_all(*_FORBIDDEN)):
        raise CompileError(f"Measure “{expr}” must be a plain aggregate expression.")
    if not any(node.find_all(exp.AggFunc)):
        raise CompileError(f"Measure “{expr}” must aggregate (SUM, COUNT, AVG, ...).")
    return node.sql(dialect=dialect)


def _grain_sql(column: str, grain: Grain | None, dialect: str) -> str:
    if grain is None:
        return column
    if grain == "day":
        return f"CAST({column} AS DATE)"
    if dialect == "postgres":
        return {
            "week": f"to_char(date_trunc('week', {column}), 'YYYY-MM-DD')",
            "month": f"to_char({column}, 'YYYY-MM')",
            "quarter": f"to_char({column}, 'YYYY-\"Q\"Q')",
            "year": f"to_char({column}, 'YYYY')",
        }[grain]
    return {
        "week": f"strftime(date_trunc('week', {column}), '%Y-%m-%d')",
        "month": f"strftime({column}, '%Y-%m')",
        "quarter": f"strftime({column}, '%Y') || '-Q' || CAST(quarter({column}) AS VARCHAR)",
        "year": f"strftime({column}, '%Y')",
    }[grain]


def measure_alias(q: SemanticQuery, i: int, ds: SemanticDataset) -> str:
    """One measure is called `value` (KPIs, YoY and charts rely on it); several keep their labels."""
    if len(q.measures) == 1:
        return "value"
    m = q.measures[i]
    if m.label:
        return m.label
    model = next((x for x in ds.measures if x.name == m.name), None)
    return (model.label or model.name) if model else f"{m.agg.lower()}_{m.column or 'rows'}"


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def compile_query(source: DataSourceSpec, q: SemanticQuery, filters: Filters, *,
                  editable: bool = False) -> tuple[str, list[Any], dict[str, Any]]:
    """SQL + bound parameters + which dashboard filters applied / were ignored.

    `editable=True` produces SQL for the SQL editor instead: static filters as escaped literals and
    a `{{filters}}` token where dashboard filters bind — no positional parameters."""
    dialect = source.dialect
    ds = _dataset(source, q.dataset)
    dims = {d.name: d for d in ds.dimensions}
    measures = {m.name: m for m in ds.measures}

    select: list[str] = []
    for i, ref in enumerate(q.dimensions):
        if ref.name not in dims:
            raise CompileError(f"Unknown dimension “{ref.name}”.")
        is_time = ref.name == ds.time_dimension or dims[ref.name].column == ds.time_dimension or dims[ref.name].type == "date"
        if ref.grain and not is_time:
            raise CompileError(f"“{ref.name}” is not a time dimension.")
        select.append(f"{_grain_sql(quote(dims[ref.name].column), ref.grain, dialect)} AS {'label' if i == 0 else 'sublabel'}")

    for i, m in enumerate(q.measures):
        if m.name:
            if m.name not in measures:
                raise CompileError(f"Unknown measure “{m.name}”.")
            sql = _measure_sql(measures[m.name].expr, dialect)
        elif m.agg == "COUNT" and not m.column:
            sql = "COUNT(*)"
        elif m.agg == "COUNT_DISTINCT":
            sql = f"COUNT(DISTINCT {quote(m.column)})"
        else:
            sql = f"{m.agg}({quote(m.column)})"
        select.append(f"{sql} AS {quote(measure_alias(q, i, ds))}")

    if editable:
        static = []
        for f in q.filters:
            if f.dimension not in dims:
                raise CompileError(f"Unknown dimension “{f.dimension}”.")
            static.append(f"AND {quote(dims[f.dimension].column)} IN ({', '.join(_literal(v) for v in f.values)})")
        where = " ".join([*static, "{{filters}}"])
        bound = None
    else:
        try:
            bound = bind(filters, ds, dialect, static={f.dimension: tuple(f.values) for f in q.filters})
        except FilterError as exc:
            raise CompileError(str(exc)) from exc
        where = bound.text()

    sql = f"SELECT {', '.join(select)}\nFROM {quote(ds.name)}\nWHERE 1=1 {where}".rstrip()
    if q.dimensions:
        sql += "\nGROUP BY " + ", ".join(str(i + 1) for i in range(len(q.dimensions)))
        first = q.dimensions[0]
        time_first = first.grain is not None or dims[first.name].type == "date"
        order = q.order or ("label_asc" if time_first else "value_desc")
        value_pos = len(q.dimensions) + 1
        sql += "\nORDER BY " + {"value_desc": f"{value_pos} DESC", "value_asc": f"{value_pos} ASC",
                                 "label_asc": "1 ASC", "label_desc": "1 DESC"}[order]
    if q.limit:
        sql += f"\nLIMIT {int(q.limit)}"
    if bound is None:
        return sql, [], {"applied": [], "ignored": []}
    return sql, bound.params, {"applied": bound.applied, "ignored": bound.ignored}
