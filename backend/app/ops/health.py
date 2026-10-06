"""Health of the whole system, for platform probes, monitoring and admins.

Card queries run on workers, so "the API answers" says little: on a bad day every worker can be alive
yet stuck, and every uncached card fails. The one signal that catches that is *progress* — workers
record each task they finish or discard, and the snapshot compares that with the queue:

    failing   Postgres or Redis unreachable, or workers stuck: no worker has made progress for
              STUCK_AFTER_S while card jobs are waiting, or while a card job has been held longer than
              that (no legitimate card job can be — its deadline and task time limit end it sooner).
              STUCK_AFTER_S exceeds the longest allowed query, so a slow BigQuery job isn't "stuck".
              Requiring "no progress" also keeps a freshly restarted worker healthy while Celery still
              lists the jobs its stuck predecessor held (cleared after the broker's visibility timeout).
    degraded  queue longer than QUEUE_WARN_DEPTH, or a data source paused by its circuit breaker
    ok        anything else — including an idle system with nothing queued

Every number comes from Redis (or the broker), so all API replicas report the same thing.
How each status is used — and why stuck workers must not fail the API's readiness — is in INSTALL.md.
"""

import asyncio
import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from redis.asyncio import Redis
from sqlalchemy import text

from app.core.config import get_settings
from app.core.redis import redis

ACTIVITY_KEY = "ops:worker_activity"     # unix time of the last task a worker finished or discarded
QUEUES = ("interactive", "refresh")
CHECK_TIMEOUT_S = 3.0

Status = Literal["ok", "degraded", "failing"]


def stuck_after_s() -> float:
    s = get_settings()
    return s.stuck_after_s if s.stuck_after_s is not None else s.query_timeout_s + 60


def mark_activity_sync(client) -> None:
    """Workers call this (sync Redis client) after every task they run or discard as expired.
    Any other queue consumer must do the same, or it will be reported as stuck."""
    client.set(ACTIVITY_KEY, time.time())


@dataclass
class Snapshot:
    status: Status
    reasons: list[str] = field(default_factory=list)
    postgres: bool = False
    redis: bool = False
    # None when unknown: inline execution, or a broker other than Redis (use the broker's own metrics)
    queue_depth: dict[str, int] | None = None
    jobs_in_flight: int | None = None
    oldest_card_job_held_s: float | None = None
    seconds_since_worker_activity: float | None = None
    breakers_open: int = 0
    workers_stuck: bool = False

    def public(self) -> dict[str, Any]:
        return asdict(self)


async def _ping_postgres() -> bool:
    from app.core.db import engine
    try:
        async with asyncio.timeout(CHECK_TIMEOUT_S):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001 — any failure means "not reachable"
        return False


def _broker() -> Redis | None:
    """The broker as a Redis client when it is Redis; None for RabbitMQ / SQS / inline."""
    s = get_settings()
    if s.execution_mode != "celery":
        return None
    url = s.celery_broker_url or s.redis_url
    if not url.startswith(("redis://", "rediss://")):
        return None
    if url == s.redis_url:
        return redis()
    return Redis.from_url(url, decode_responses=True)


async def _queue_stats(broker: Redis) -> tuple[dict[str, int], int, float | None]:
    """Queue depths, jobs in flight, and how long the oldest in-flight *card* job has been held."""
    depth = {}
    for name in QUEUES:
        # Kombu keeps one list per queue (plus one per priority level, if priorities are used)
        keys = [name, *(f"{name}\x06\x16{p}" for p in (3, 6, 9))]
        depth[name] = sum([await broker.llen(k) for k in keys])
    # Jobs a worker has taken but not acknowledged: `unacked` holds [message, exchange, routing key],
    # `unacked_index` when each was handed out. Refresh jobs may legitimately run long — skip them.
    oldest = None
    now = time.time()
    for tag, delivered in await broker.zrange("unacked_index", 0, 49, withscores=True):
        raw = await broker.hget("unacked", tag)
        try:
            routing_key = json.loads(raw)[2] if raw else None
        except (ValueError, IndexError, TypeError):
            routing_key = None
        if routing_key == "interactive":
            oldest = round(now - delivered, 1)
            break
    return depth, await broker.hlen("unacked"), oldest


async def snapshot() -> Snapshot:
    s = get_settings()
    snap = Snapshot(status="ok", postgres=await _ping_postgres())
    try:
        async with asyncio.timeout(CHECK_TIMEOUT_S):
            r = redis()
            await r.ping()
            snap.redis = True
            last = await r.get(ACTIVITY_KEY)
            snap.seconds_since_worker_activity = round(time.time() - float(last), 1) if last else None
            snap.breakers_open = len([k async for k in r.scan_iter("breaker:*", count=500)])
            broker = _broker()
            if broker is not None:
                snap.queue_depth, snap.jobs_in_flight, snap.oldest_card_job_held_s = await _queue_stats(broker)
                if broker is not r:
                    await broker.aclose()
    except Exception:  # noqa: BLE001
        snap.redis = False

    if not snap.postgres:
        snap.reasons.append("Postgres is unreachable.")
    if not snap.redis:
        snap.reasons.append("Redis is unreachable.")
    limit = stuck_after_s()
    idle = snap.seconds_since_worker_activity
    no_progress = idle is None or idle > limit
    progress = "ever recorded" if idle is None else f"for {idle:.0f} s"
    if no_progress and snap.queue_depth is not None:
        if snap.queue_depth.get("interactive", 0) > 0:
            snap.workers_stuck = True
            snap.reasons.append(f"{snap.queue_depth['interactive']} card job(s) waiting and no worker progress {progress}.")
        if snap.oldest_card_job_held_s is not None and snap.oldest_card_job_held_s > limit:
            snap.workers_stuck = True
            snap.reasons.append(f"A card job has been held by a worker for {snap.oldest_card_job_held_s:.0f} s "
                                f"(no card job may run longer than {limit:.0f} s) and no worker progress {progress}.")
    if snap.reasons:
        snap.status = "failing"
    else:
        total = sum((snap.queue_depth or {}).values())
        if total > s.queue_warn_depth:
            snap.reasons.append(f"{total} jobs queued (warning above {s.queue_warn_depth}).")
        if snap.breakers_open:
            snap.reasons.append(f"{snap.breakers_open} data source(s) paused by the circuit breaker.")
        if snap.reasons:
            snap.status = "degraded"
    return snap


# ---------------------------------------------------------------- Prometheus text format
def _line(name: str, value: float | int | None, labels: dict[str, str] | None = None) -> str | None:
    if value is None:
        return None
    label = "{" + ",".join(f'{k}="{v}"' for k, v in labels.items()) + "}" if labels else ""
    return f"{name}{label} {value}"


async def metrics_text() -> str:
    from app.execution import jobs

    snap = await snapshot()
    lines: list[str | None] = []

    def gauge(name: str, help_: str, *samples: tuple[float | int | None, dict[str, str] | None]):
        lines.extend([f"# HELP {name} {help_}", f"# TYPE {name} gauge"])
        lines.extend(_line(name, v, lb) for v, lb in samples)

    def counter(name: str, help_: str, *samples: tuple[float | int | None, dict[str, str] | None]):
        lines.extend([f"# HELP {name} {help_}", f"# TYPE {name} counter"])
        lines.extend(_line(name, v, lb) for v, lb in samples)

    gauge("spendboard_status", "Overall health: 0 ok, 1 degraded, 2 failing.",
          ({"ok": 0, "degraded": 1, "failing": 2}[snap.status], None))
    gauge("spendboard_up", "Dependency reachable (1) or not (0).",
          (int(snap.postgres), {"component": "postgres"}), (int(snap.redis), {"component": "redis"}))
    gauge("spendboard_workers_stuck", "1 when card jobs wait and workers have made no progress.", (int(snap.workers_stuck), None))
    if snap.queue_depth is not None:
        gauge("spendboard_queue_depth", "Jobs waiting for a worker.",
              *((n, {"queue": q}) for q, n in snap.queue_depth.items()))
        gauge("spendboard_jobs_in_flight", "Jobs taken by workers and not yet finished.", (snap.jobs_in_flight, None))
        gauge("spendboard_oldest_card_job_held_seconds", "How long the oldest in-flight card job has been held.",
              (snap.oldest_card_job_held_s if snap.oldest_card_job_held_s is not None else 0, None))
    gauge("spendboard_seconds_since_worker_activity", "Seconds since a worker last finished or discarded a task.",
          (snap.seconds_since_worker_activity, None))
    gauge("spendboard_breakers_open", "Data sources currently paused by the circuit breaker.", (snap.breakers_open, None))

    if snap.redis:
        st = await jobs.stats()
        counter("spendboard_card_lookups_total", "Card result lookups by outcome.",
                *((st.get(k, 0), {"result": k}) for k in ("hit", "stale", "miss")))
        counter("spendboard_card_jobs_total", "Card computations by outcome.",
                (st.get("computed", 0), {"outcome": "computed"}), (st.get("errors", 0), {"outcome": "error"}))
        gauge("spendboard_compute_seconds", "Card computation time over the last 1000 jobs.",
              *((round(st[k] / 1000, 4) if st.get(k) is not None else None, {"quantile": q})
                for k, q in (("compute_ms_p50", "0.5"), ("compute_ms_p95", "0.95"))))
    return "\n".join(x for x in lines if x is not None) + "\n"
