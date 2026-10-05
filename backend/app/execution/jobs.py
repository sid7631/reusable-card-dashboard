"""Cached, deduplicated card execution (architecture §8).

    request ──► Redis result cache ──hit──► serve (fresh, or stale + background refresh)
                      │ miss
                      ▼
               single-flight lock ──held by someone else──► wait for their result
                      │ acquired
                      ▼
               dispatch job (Celery worker, or inline) ──► per-source semaphore ──► source
                      │
                      ▼
               write cache + publish "done"

Cache keys combine the *immutable* card version, data-source version and the canonical filters, so
a hit can never serve the wrong definition. Results are the same for every user (no row-level
security), so one execution serves everyone looking at the same view.
"""

import asyncio
import hashlib
import json
import logging
import random
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from app.connectors.common import QueryError
from app.core.config import get_settings
from app.core.redis import redis
from app.execution.cards import run_card
from app.execution.sql import SqlValidationError
from app.governance.specs import CardSpec, DataSourceSpec
from app.semantic.filters import FilterError, Filters
from app.semantic.query import CompileError

log = logging.getLogger("spendboard.jobs")

USER_ERRORS = (QueryError, SqlValidationError, CompileError, FilterError)


# ---------------------------------------------------------------- jobs
def filters_to_json(f: Filters) -> dict[str, Any]:
    return {"dims": {k: list(v) for k, v in f.dims.items()},
            "from": f.date_from.isoformat() if f.date_from else None, "to": f.date_to.isoformat() if f.date_to else None}


def filters_from_json(d: dict[str, Any]) -> Filters:
    return Filters.parse(None, None, d.get("from"), d.get("to"), d.get("dims") or {})


@dataclass(frozen=True)
class Job:
    """Everything a worker needs — no database reads for the card or source definition."""
    card_version_id: int
    card_spec: dict[str, Any]
    source_version_id: int
    source_spec: dict[str, Any]
    filters: dict[str, Any]

    @property
    def key(self) -> str:
        digest = hashlib.sha256(json.dumps(self.filters, sort_keys=True).encode()).hexdigest()[:20]
        return f"res:{self.card_version_id}:{self.source_version_id}:{digest}"

    @property
    def source(self) -> DataSourceSpec:
        return DataSourceSpec.model_validate(self.source_spec)

    @property
    def endpoint_key(self) -> str:
        """Concurrency and circuit-breaker scope: the physical endpoint, shared by every version and copy."""
        return hashlib.sha256(json.dumps(self.source.endpoint(), default=str).encode()).hexdigest()[:16]

    def to_json(self) -> dict[str, Any]:
        return self.__dict__.copy()


def make_job(card_version_id: int, card_spec: dict, source_version_id: int, source_spec: dict, filters: Filters) -> Job:
    return Job(card_version_id, card_spec, source_version_id, source_spec, filters_to_json(filters))


@dataclass
class Result:
    rows: list[dict[str, Any]]
    meta: dict[str, Any]
    computed_at: float
    cached: bool
    stale: bool

    def payload(self) -> dict[str, Any]:
        return {"rows": self.rows, "meta": self.meta, "as_of": self.computed_at, "cached": self.cached, "stale": self.stale}


# ---------------------------------------------------------------- stats
async def _count(field: str, n: int = 1) -> None:
    await redis().hincrby("stats:cards", field, n)


async def stats() -> dict[str, Any]:
    r = redis()
    counts = {k: int(v) for k, v in (await r.hgetall("stats:cards")).items()}
    durations = sorted(float(x) for x in await r.lrange("stats:compute_ms", 0, -1))
    pct = lambda p: round(durations[min(len(durations) - 1, int(p * len(durations)))], 1) if durations else None  # noqa: E731
    lookups = counts.get("hit", 0) + counts.get("stale", 0) + counts.get("miss", 0)
    return {**counts, "hit_ratio": round((counts.get("hit", 0) + counts.get("stale", 0)) / lookups, 3) if lookups else None,
            "compute_ms_p50": pct(0.5), "compute_ms_p95": pct(0.95), "compute_samples": len(durations)}


# ---------------------------------------------------------------- reading
async def get_result(job: Job, *, wait: bool = True) -> Result | None:
    """Serve from cache, or compute once and share. With wait=False only triggers (warm-up)."""
    r = redis()
    raw = await r.get(job.key)
    if raw:
        entry = json.loads(raw)
        fresh = time.time() < entry["fresh_until"]
        await _count("hit" if fresh else "stale")
        if not fresh:
            await trigger(job)  # stale-while-revalidate
        return Result(entry["rows"], entry["meta"], entry["computed_at"], cached=True, stale=not fresh)

    await _count("miss")
    if not wait:
        await trigger(job)
        return None

    # Subscribe before triggering so the completion message can't slip past us
    pubsub = r.pubsub()
    await pubsub.subscribe(f"done:{job.key}")
    try:
        await trigger(job)
        # Wait as long as the query may legitimately run (long BigQuery jobs included), plus queueing
        deadline = time.monotonic() + max(get_settings().result_wait_s, job_deadline_s(job.source) + 15)
        while time.monotonic() < deadline:
            raw = await r.get(job.key)
            if raw:
                entry = json.loads(raw)
                return Result(entry["rows"], entry["meta"], entry["computed_at"], cached=False, stale=False)
            error = await r.get(f"err:{job.key}")
            if error:
                raise QueryError(error)
            if not await r.exists(f"lock:{job.key}"):
                # The computing job vanished (worker crash, lost message) — take over
                await trigger(job)
            await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
        raise QueryError("Timed out waiting for the query — the workers may be busy or offline.")
    finally:
        await pubsub.unsubscribe()
        await pubsub.aclose()


def job_deadline_s(source: DataSourceSpec) -> float:
    """Hard ceiling on one card job, a little above the source's query timeout."""
    return min(source.execution.timeout_s, get_settings().query_timeout_s) + 10


async def trigger(job: Job) -> None:
    """Start a computation unless one for the same key is already running (single-flight)."""
    r = redis()
    # Long enough for a queued job to run to its statement timeout; short enough that a lost job is
    # retried by its waiters (see get_result) rather than blocking a view for minutes
    lock_ttl = int(job.source.execution.timeout_s + 20)
    if await r.set(f"lock:{job.key}", "1", nx=True, ex=lock_ttl):
        await r.delete(f"err:{job.key}")
        await dispatch(job, expires_s=lock_ttl)


async def dispatch(job: Job, *, expires_s: float | None = None) -> None:
    from app.execution import queue
    # A job still queued when its lock expires has been re-triggered by its waiters (or they gave
    # up), so drop it instead of piling up duplicates behind busy workers
    await queue.submit("run_card", job.to_json(), expires_s=expires_s)


# ---------------------------------------------------------------- computing
@asynccontextmanager
async def source_slot(endpoint_key: str, limit: int, hold_s: float = 60):
    """Cluster-wide cap on concurrent queries per source endpoint (Redis counting semaphore).
    `hold_s`: the longest a holder can keep its slot (its query deadline)."""
    r = redis()
    key = f"sem:{endpoint_key}"
    deadline = time.monotonic() + get_settings().result_wait_s
    while True:
        n = await r.incr(key)
        # Outlives any legitimate holder (else the count resets mid-query and the cap leaks), while a
        # crashed holder still can't leak a slot for long
        await r.expire(key, int(max(120, hold_s + 60)))
        if n <= limit:
            break
        await r.decr(key)
        if time.monotonic() > deadline:
            raise QueryError("The data source is busy — try again shortly.")
        await asyncio.sleep(0.05 + random.random() * 0.1)
    try:
        yield
    finally:
        await r.decr(key)


async def compute(job: Job) -> None:
    r = redis()
    settings = get_settings()
    source = job.source
    t0 = time.perf_counter()
    try:
        if await r.exists(f"breaker:{job.endpoint_key}"):
            raise QueryError("This data source is failing — paused briefly to let it recover.")
        async with source_slot(job.endpoint_key, source.execution.max_concurrency, job_deadline_s(source)):
            # Connectors enforce their own timeouts; this bounds anything that slips past them (a
            # client library retrying, a stalled connection) so a job can never hold a worker
            try:
                result = await asyncio.wait_for(
                    run_card(CardSpec.model_validate(job.card_spec), source, filters_from_json(job.filters)),
                    timeout=job_deadline_s(source))
            except TimeoutError:
                raise QueryError("Query timed out.") from None
        now = time.time()
        ttl = source.execution.cache_ttl_s
        entry = {**result, "computed_at": now, "fresh_until": now + ttl}
        await r.set(job.key, json.dumps(entry, default=str), ex=ttl + settings.stale_grace_s)
        await _count("computed")
        await r.lpush("stats:compute_ms", round((time.perf_counter() - t0) * 1000, 1))
        await r.ltrim("stats:compute_ms", 0, 999)
    except USER_ERRORS as exc:
        await _fail(job, str(exc), count_against_source=isinstance(exc, QueryError))
    except Exception:  # noqa: BLE001 — never leave waiters hanging
        log.exception("card job failed: %s", job.key)
        await _fail(job, "Internal error while running the card.", count_against_source=False)
    finally:
        await r.delete(f"lock:{job.key}")
        await r.publish(f"done:{job.key}", "1")


async def _fail(job: Job, message: str, *, count_against_source: bool) -> None:
    r = redis()
    settings = get_settings()
    await r.set(f"err:{job.key}", message, ex=30)
    await _count("errors")
    if count_against_source and "paused briefly" not in message:
        failures = await r.incr(f"fail:{job.endpoint_key}")
        await r.expire(f"fail:{job.endpoint_key}", 60)
        if failures >= settings.breaker_failures:
            await r.set(f"breaker:{job.endpoint_key}", "1", ex=settings.breaker_open_s)
            await r.delete(f"fail:{job.endpoint_key}")
