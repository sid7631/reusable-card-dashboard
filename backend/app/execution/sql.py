"""SQL validation and filter binding for card queries.

Card SQL keeps a `{{filters}}` token. It is replaced with conditions whose values are bound as
query parameters ($1, $2, ...) — never interpolated into the SQL text.
"""

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

FILTER_TOKEN = "{{filters}}"

_WRITE_NODES = (exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop, exp.Alter,
                exp.Command, exp.Into, exp.TruncateTable, exp.Lock, exp.Copy, exp.Attach, exp.Pragma, exp.Set)


class SqlValidationError(ValueError):
    pass


@dataclass(frozen=True)
class Filters:
    segment: str | None = None
    sub_segments: tuple[str, ...] = field(default_factory=tuple)
    date_from: date | None = None
    date_to: date | None = None

    @classmethod
    def parse(cls, segment: str | None = None, sub_segments: str | None = None,
              date_from: str | None = None, date_to: str | None = None) -> "Filters":
        try:
            return cls(
                segment=segment if segment and segment != "ALL" else None,
                sub_segments=tuple(s.strip() for s in (sub_segments or "").split(",") if s.strip()),
                date_from=date.fromisoformat(date_from) if date_from else None,
                date_to=date.fromisoformat(date_to) if date_to else None,
            )
        except ValueError as exc:
            raise SqlValidationError("Invalid date — expected YYYY-MM-DD.") from exc

    def shifted_one_year_back(self) -> "Filters":
        def back(d: date | None) -> date | None:
            if d is None:
                return None
            try:
                return d.replace(year=d.year - 1)
            except ValueError:  # 29 Feb
                return d.replace(year=d.year - 1, day=28)
        return Filters(self.segment, self.sub_segments, back(self.date_from), back(self.date_to))


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
    return text


def bind_filters(sql: str, filters: Filters, dialect: str = "postgres") -> tuple[str, list[Any]]:
    """Validate `sql` and replace the filters token with bound conditions."""
    text = validate_sql(sql, dialect)
    parts: list[str] = []
    params: list[Any] = []

    def param(value: Any) -> str:
        params.append(value)
        return f"${len(params)}"

    if filters.segment:
        parts.append(f"AND segment = {param(filters.segment)}")
    if filters.sub_segments:
        parts.append(f"AND sub_segment = ANY({param(list(filters.sub_segments))}::text[])")
    if filters.date_from:
        parts.append(f"AND txn_date >= {param(filters.date_from)}")
    if filters.date_to:
        parts.append(f"AND txn_date <= {param(filters.date_to)}")

    if FILTER_TOKEN not in text:
        return text, []
    return text.replace(FILTER_TOKEN, " ".join(parts)), params
