"""SQL validation and filter binding for raw-SQL cards.

Card SQL keeps a `{{filters}}` token. It is replaced with conditions — bound through the source's
semantic model — whose values are query parameters ($1, $2, ...), never interpolated into the SQL.
"""

import re
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from app.governance.specs import DataSourceSpec, SemanticDataset
from app.semantic.filters import Filters, bind

FILTER_TOKEN = "{{filters}}"

_WRITE_NODES = (exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop, exp.Alter,
                exp.Command, exp.Into, exp.TruncateTable, exp.Lock, exp.Copy, exp.Attach, exp.Pragma, exp.Set,
                exp.Export)  # BigQuery EXPORT DATA writes query results to Cloud Storage


class SqlValidationError(ValueError):
    pass


def validate_sql(sql: str, dialect: str = "postgres") -> str:
    """Return the single read-only statement, normalised; raise SqlValidationError otherwise."""
    if not isinstance(sql, str) or not sql.strip():
        raise SqlValidationError("SQL is required.")
    text = sql.strip().rstrip(";").strip()
    if re.search(r"\$\d", text):
        raise SqlValidationError("Positional parameters ($1, ...) are reserved for filters.")
    try:
        statements = [s for s in sqlglot.parse(text.replace(FILTER_TOKEN, ""), dialect=dialect) if s is not None]
    except ParseError as exc:
        raise SqlValidationError(f"Could not parse SQL: {exc.errors[0]['description'] if exc.errors else exc}") from exc
    if len(statements) != 1:
        raise SqlValidationError("Exactly one SQL statement is allowed.")
    stmt = statements[0]
    if not isinstance(stmt, exp.Query) or any(stmt.find_all(*_WRITE_NODES)):
        raise SqlValidationError("Only read-only SELECT queries are allowed.")
    if any(stmt.find_all(exp.Parameter, exp.Placeholder)):
        raise SqlValidationError("Query parameters ($1, @name, ?) are reserved for filters.")
    return text


def _dataset_for(sql: str, source: DataSourceSpec) -> SemanticDataset | None:
    """The modelled table the SQL reads from (first match), else the source's primary dataset."""
    try:
        tables = set()
        for t in sqlglot.parse_one(sql.replace(FILTER_TOKEN, ""), dialect=source.dialect).find_all(exp.Table):
            tables |= {t.name, f"{t.db}.{t.name}" if t.db else t.name}  # model names may be dataset-qualified
    except ParseError:
        tables = set()
    datasets = source.model.datasets
    return next((d for d in datasets if d.name in tables), datasets[0] if datasets else None)


def bind_filters(sql: str, filters: Filters, source: DataSourceSpec) -> tuple[str, list[Any], dict[str, Any]]:
    """Validate `sql` and replace the filters token with bound conditions.

    Returns SQL, parameters, and which filters applied / were ignored. Without the token the
    query runs unfiltered and every requested filter is reported as ignored.
    """
    text = validate_sql(sql, source.dialect)
    bound = bind(filters, _dataset_for(text, source), source.dialect)
    if FILTER_TOKEN not in text:
        requested = [*filters.dims, *(["period"] if filters.date_from or filters.date_to else [])]
        return text, [], {"applied": [], "ignored": requested}
    return text.replace(FILTER_TOKEN, bound.text()), bound.params, {"applied": bound.applied, "ignored": bound.ignored}
