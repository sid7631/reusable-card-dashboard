import pytest

from app.execution.sql import Filters, SqlValidationError, bind_filters, validate_sql


@pytest.mark.parametrize("sql", [
    "SELECT 'a;b' AS x",                       # semicolon inside a literal (rejected by the old POC)
    "SELECT 1;",                               # trailing semicolon
    "WITH t AS (SELECT 1 AS v) SELECT v FROM t",
    "SELECT 1 UNION ALL SELECT 2",
])
def test_allows_single_read_only_query(sql):
    validate_sql(sql)


@pytest.mark.parametrize("sql", [
    "SELECT 1; SELECT 2",
    "DELETE FROM transactions",
    "UPDATE transactions SET amount = 0",
    "DROP TABLE transactions",
    "SELECT * INTO copy FROM transactions",
    "WITH d AS (DELETE FROM transactions RETURNING *) SELECT * FROM d",
    "SELECT $1",
    "",
])
def test_rejects_writes_multiple_statements_and_placeholders(sql):
    with pytest.raises(SqlValidationError):
        validate_sql(sql)


def test_filters_are_bound_parameters_not_interpolated():
    hostile = "GCS' OR '1'='1"
    sql, params = bind_filters("SELECT 1 FROM transactions WHERE 1=1 {{filters}}",
                               Filters.parse(hostile, "SBS,MM", "2026-01-01", "2026-03-31"))
    assert hostile not in sql
    assert sql.endswith("AND segment = $1 AND sub_segment = ANY($2::text[]) AND txn_date >= $3 AND txn_date <= $4")
    assert params[0] == hostile and params[1] == ["SBS", "MM"]


def test_invalid_date_rejected():
    with pytest.raises(SqlValidationError):
        Filters.parse(date_from="2026-02-30")


def test_yoy_shift_handles_leap_day():
    shifted = Filters.parse(date_from="2024-02-29", date_to="2024-03-31").shifted_one_year_back()
    assert str(shifted.date_from) == "2023-02-28" and str(shifted.date_to) == "2023-03-31"
