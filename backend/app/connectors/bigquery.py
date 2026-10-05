"""BigQuery connector: typed query parameters, a bytes-billed cap on every query, timeouts that
cancel the job, and introspection of the source's dataset.

Cost is the main difference from Postgres: BigQuery bills per byte scanned. Every query carries
`maximum_bytes_billed` (a query that would scan more fails before running, at no charge), results
go through the platform's result cache, and BigQuery's own query cache stays on.
"""

import asyncio
import concurrent.futures
import datetime as dt
import json
import threading
from decimal import Decimal
from typing import Any

from google.api_core import exceptions as gexc
from google.cloud import bigquery

from app.connectors.common import QueryError, jsonable
from app.core import secrets
from app.core.config import get_settings
from app.governance.specs import DataSourceSpec

_clients: dict[tuple[Any, ...], bigquery.Client] = {}
_lock = threading.Lock()
SCOPES = ["https://www.googleapis.com/auth/bigquery"]


async def _credentials_key(spec: DataSourceSpec) -> tuple[Any, ...]:
    cfg = spec.bigquery
    if get_settings().bigquery_emulator_host:
        return ("emulator", cfg.project)
    if cfg.auth == "adc":
        return ("adc", cfg.project)
    if not cfg.secret_ref:
        raise QueryError("Add a service-account key for this BigQuery source.")
    try:
        key = await secrets.resolve(cfg.secret_ref)
    except secrets.SecretError as exc:
        raise QueryError(str(exc)) from exc
    return ("key", cfg.project, key)


def _build_client(key: tuple[Any, ...], location: str | None) -> bigquery.Client:
    kind, project = key[0], key[1]
    if kind == "emulator":
        from google.api_core.client_options import ClientOptions
        from google.auth.credentials import AnonymousCredentials
        return bigquery.Client(project=project, location=location, credentials=AnonymousCredentials(),
                               client_options=ClientOptions(api_endpoint=get_settings().bigquery_emulator_host))
    if kind == "adc":
        import google.auth
        credentials, _ = google.auth.default(scopes=SCOPES)
        return bigquery.Client(project=project, location=location, credentials=credentials)
    from google.oauth2 import service_account
    try:
        info = json.loads(key[2])
        credentials = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    except (ValueError, KeyError) as exc:
        raise QueryError("The service-account key isn't valid JSON from Google Cloud.") from exc
    return bigquery.Client(project=project, location=location, credentials=credentials)


async def _client(spec: DataSourceSpec) -> bigquery.Client:
    key = await _credentials_key(spec)
    cache_key = (*key, spec.bigquery.location)
    with _lock:
        if cache_key not in _clients:
            _clients[cache_key] = _build_client(key, spec.bigquery.location)
        return _clients[cache_key]


def _param(name: str, value: Any) -> bigquery.ScalarQueryParameter | bigquery.ArrayQueryParameter:
    if isinstance(value, (list, tuple)):
        return bigquery.ArrayQueryParameter(name, "STRING", [str(v) for v in value])
    if isinstance(value, bool):
        return bigquery.ScalarQueryParameter(name, "BOOL", value)
    if isinstance(value, dt.datetime):
        return bigquery.ScalarQueryParameter(name, "TIMESTAMP", value)
    if isinstance(value, dt.date):
        return bigquery.ScalarQueryParameter(name, "DATE", value)
    if isinstance(value, int):
        return bigquery.ScalarQueryParameter(name, "INT64", value)
    if isinstance(value, (float, Decimal)):
        return bigquery.ScalarQueryParameter(name, "FLOAT64", float(value))
    return bigquery.ScalarQueryParameter(name, "STRING", str(value))


def _friendly(exc: Exception, spec: DataSourceSpec) -> str:
    text = getattr(exc, "message", None) or str(exc)
    reasons = {e.get("reason") for e in getattr(exc, "errors", None) or [] if isinstance(e, dict)}
    if "bytesBilledLimitExceeded" in reasons or "bytes billed" in text.lower():
        gb = spec.bigquery.maximum_bytes_billed / 1024**3
        return f"This query would scan more than {gb:g} GB (the source's limit). Add filters or raise the limit."
    if isinstance(exc, (gexc.Unauthorized, gexc.Forbidden)):
        return "BigQuery refused access — check the service account's roles (BigQuery Data Viewer + Job User)."
    if isinstance(exc, gexc.NotFound):
        return text.split("\n")[0]
    return text.split("\n")[0][:500]


def _run(client: bigquery.Client, spec: DataSourceSpec, sql: str, params: list[Any], max_rows: int,
         timeout_s: float) -> list[dict[str, Any]]:
    cfg = spec.bigquery
    job_config = bigquery.QueryJobConfig(
        default_dataset=f"{cfg.project}.{cfg.dataset}",
        query_parameters=[_param(f"p{i + 1}", v) for i, v in enumerate(params)],
        maximum_bytes_billed=cfg.maximum_bytes_billed,
        use_query_cache=True,
        labels={"app": "spendboard"},
    )
    job_config.job_timeout_ms = int(timeout_s * 1000)  # server-side limit as well as the client wait
    job = client.query(sql, job_config=job_config, location=cfg.location)
    try:
        rows = job.result(timeout=timeout_s, max_results=max_rows)
    except concurrent.futures.TimeoutError:
        job.cancel()
        raise QueryError("Query timed out.") from None
    return [{k: jsonable(v) for k, v in row.items()} for row in rows]


async def execute(spec: DataSourceSpec, sql: str, params: list[Any], *, max_rows: int | None = None) -> list[dict[str, Any]]:
    settings = get_settings()
    timeout_s = min(spec.execution.timeout_s, settings.query_timeout_s)
    client = await _client(spec)
    try:
        return await asyncio.to_thread(_run, client, spec, sql, params, max_rows or settings.query_max_rows, timeout_s)
    except QueryError:
        raise
    except gexc.GoogleAPIError as exc:
        raise QueryError(_friendly(exc, spec)) from exc
    except Exception as exc:  # transport errors, auth refresh failures
        raise QueryError(f"Could not reach BigQuery: {str(exc).splitlines()[0][:200]}") from exc


def _introspect(client: bigquery.Client, spec: DataSourceSpec) -> list[dict[str, Any]]:
    cfg = spec.bigquery
    tables = []
    for item in list(client.list_tables(f"{cfg.project}.{cfg.dataset}", max_results=200)):
        table = client.get_table(item.reference)
        columns = [{"name": f.name, "type": f.field_type}
                   for f in table.schema if f.mode != "REPEATED" and f.field_type not in ("RECORD", "STRUCT")]
        tables.append({"name": table.table_id, "row_count": table.num_rows or 0, "columns": columns})
    return tables


async def introspect(spec: DataSourceSpec) -> list[dict[str, Any]]:
    client = await _client(spec)
    try:
        return await asyncio.to_thread(_introspect, client, spec)
    except gexc.GoogleAPIError as exc:
        raise QueryError(_friendly(exc, spec)) from exc
    except Exception as exc:
        raise QueryError(f"Could not reach BigQuery: {str(exc).splitlines()[0][:200]}") from exc


async def test(spec: DataSourceSpec) -> list[dict[str, Any]]:
    """Fresh client (nothing cached for a config that may be wrong), then list the dataset's tables."""
    key = await _credentials_key(spec)
    client = await asyncio.to_thread(_build_client, key, spec.bigquery.location)
    try:
        await asyncio.to_thread(client.get_dataset, f"{spec.bigquery.project}.{spec.bigquery.dataset}")
        return await asyncio.to_thread(_introspect, client, spec)
    except gexc.GoogleAPIError as exc:
        raise QueryError(_friendly(exc, spec)) from exc
    except Exception as exc:
        raise QueryError(f"Could not reach BigQuery: {str(exc).splitlines()[0][:200]}") from exc
