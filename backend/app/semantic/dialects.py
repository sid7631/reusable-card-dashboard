"""SQL dialect differences in one place: Postgres, DuckDB and BigQuery.

Everything that generates SQL — the semantic compiler, filter binding, option lists, catalog queries —
goes through these helpers instead of hard-coding quoting, parameters or date functions.

                 identifier   string escape   parameter   list membership
    postgres     "col"        'O''Brien'      $1          CAST(col AS TEXT) = ANY($1::text[])
    duckdb       "col"        'O''Brien'      $1          list_contains(CAST($1 AS VARCHAR[]), CAST(col AS VARCHAR))
    bigquery     `col`        'O\\'Brien'      @p1         CAST(col AS STRING) IN UNNEST(@p1)
"""

from sqlglot import exp

DIALECTS = ("postgres", "duckdb", "bigquery")
TEMPORAL_TYPES = ("date", "datetime", "timestamp")


def quote(ident: str, dialect: str) -> str:
    return exp.to_identifier(ident, quoted=True).sql(dialect=dialect)


def quote_table(name: str, dialect: str) -> str:
    """A table name, optionally qualified (`dataset.table`, `project.dataset.table`, `schema.table`)."""
    return ".".join(quote(part, dialect) for part in name.split("."))


def literal(value: str, dialect: str) -> str:
    return exp.Literal.string(value).sql(dialect=dialect)


def placeholder(n: int, dialect: str) -> str:
    """The n-th (1-based) bound parameter."""
    return f"@p{n}" if dialect == "bigquery" else f"${n}"


def membership(column_sql: str, ph: str, dialect: str) -> str:
    """`column IN (values)` with the values bound as one text-array parameter."""
    if dialect == "postgres":
        return f"CAST({column_sql} AS TEXT) = ANY({ph}::text[])"
    if dialect == "bigquery":
        return f"CAST({column_sql} AS STRING) IN UNNEST({ph})"
    return f"list_contains(CAST({ph} AS VARCHAR[]), CAST({column_sql} AS VARCHAR))"


def date_param(ph: str, dialect: str) -> str:
    """A bound date parameter, typed so it compares cleanly with date/time columns."""
    if dialect == "postgres":
        return f"{ph}::date"
    if dialect == "duckdb":
        return f"CAST({ph} AS DATE)"
    return ph  # BigQuery parameters carry their type (DATE)


def time_bounds(column_sql: str, column_type: str, lower_ph: str | None, upper_ph: str | None, dialect: str) -> list[str]:
    """Conditions for a date window on a time column.

    DATE columns use an inclusive upper bound. DATETIME / TIMESTAMP columns use `< upper` where the
    caller binds the day *after* the window's last day — so the whole last day is included. BigQuery
    won't compare TIMESTAMP or DATETIME with DATE, so the bound is converted to the column's type.
    """
    wrap = {"timestamp": "TIMESTAMP", "datetime": "DATETIME"}.get(column_type) if dialect == "bigquery" else None
    bound = (lambda ph: f"{wrap}({ph})") if wrap else (lambda ph: date_param(ph, dialect))
    out = []
    if lower_ph:
        out.append(f"{column_sql} >= {bound(lower_ph)}")
    if upper_ph:
        op = "<" if column_type in ("datetime", "timestamp") else "<="
        out.append(f"{column_sql} {op} {bound(upper_ph)}")
    return out


def grain_sql(column_sql: str, grain: str | None, dialect: str) -> str:
    """Bucket a time column: day → a date; week/month/quarter/year → sortable text labels."""
    if grain is None:
        return column_sql
    if dialect == "bigquery":
        d = f"DATE({column_sql})"
        return {
            "day": d,
            "week": f"FORMAT_DATE('%Y-%m-%d', DATE_TRUNC({d}, WEEK(MONDAY)))",
            "month": f"FORMAT_DATE('%Y-%m', {d})",
            "quarter": f"CONCAT(FORMAT_DATE('%Y', {d}), '-Q', CAST(EXTRACT(QUARTER FROM {d}) AS STRING))",
            "year": f"FORMAT_DATE('%Y', {d})",
        }[grain]
    if grain == "day":
        return f"CAST({column_sql} AS DATE)"
    if dialect == "postgres":
        return {
            "week": f"to_char(date_trunc('week', {column_sql}), 'YYYY-MM-DD')",
            "month": f"to_char({column_sql}, 'YYYY-MM')",
            "quarter": f"to_char({column_sql}, 'YYYY-\"Q\"Q')",
            "year": f"to_char({column_sql}, 'YYYY')",
        }[grain]
    return {
        "week": f"strftime(date_trunc('week', {column_sql}), '%Y-%m-%d')",
        "month": f"strftime({column_sql}, '%Y-%m')",
        "quarter": f"strftime({column_sql}, '%Y') || '-Q' || CAST(quarter({column_sql}) AS VARCHAR)",
        "year": f"strftime({column_sql}, '%Y')",
    }[grain]
