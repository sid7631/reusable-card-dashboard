"""Health: stuck workers are detected from progress, never confused with slow queries, and never take
the API out of service."""

import time

import pytest
from redis.asyncio import Redis

from app.core.config import get_settings
from app.core.redis import redis
from app.ops import check, health


@pytest.fixture
async def celery_mode(monkeypatch):
    """Report on the (Redis) broker as in production; the test Redis stands in for it."""
    monkeypatch.setattr(get_settings(), "execution_mode", "celery")
    monkeypatch.setattr(get_settings(), "stuck_after_s", 60)
    r = redis()
    await r.delete("interactive", "refresh", "unacked", "unacked_index", health.ACTIVITY_KEY)
    yield r
    await r.delete("interactive", "refresh", "unacked", "unacked_index", health.ACTIVITY_KEY)
    async for key in r.scan_iter("breaker:*"):
        await r.delete(key)


async def queue_jobs(r, n: int, queue: str = "interactive"):
    await r.rpush(queue, *[f'{{"job": {i}}}' for i in range(n)])


async def test_idle_system_is_healthy(celery_mode):
    snap = await health.snapshot()
    assert (snap.status, snap.workers_stuck) == ("ok", False)
    assert snap.queue_depth == {"interactive": 0, "refresh": 0}


async def test_waiting_jobs_without_progress_mean_stuck_workers(client, celery_mode):
    await queue_jobs(celery_mode, 3)
    await celery_mode.set(health.ACTIVITY_KEY, time.time() - 1000)
    snap = await health.snapshot()
    assert snap.status == "failing" and snap.workers_stuck
    assert "3 card job(s) waiting" in snap.reasons[0]
    assert await check.main(verbose=False) == 1              # worker liveness fails → platform restarts workers

    ready = await client.get("/readyz")                       # …but the API keeps serving
    assert ready.status_code == 200 and ready.json()["status"] == "ready"
    metrics = (await client.get("/metrics")).text
    assert "spendboard_workers_stuck 1" in metrics and "spendboard_status 2" in metrics
    assert 'spendboard_queue_depth{queue="interactive"} 3' in metrics


async def test_jobs_waiting_and_no_worker_ever_seen_is_stuck(celery_mode):
    await queue_jobs(celery_mode, 1)
    assert (await health.snapshot()).workers_stuck


async def test_long_queries_with_recent_progress_are_not_stuck(celery_mode, monkeypatch):
    # e.g. all workers busy with 2-minute BigQuery jobs: nothing finished for 30 s, well within the limit
    await queue_jobs(celery_mode, 40)
    await celery_mode.set(health.ACTIVITY_KEY, time.time() - 30)
    snap = await health.snapshot()
    assert snap.status == "ok" and not snap.workers_stuck
    assert await check.main(verbose=False) == 0


async def test_long_queue_and_open_breakers_are_degraded_not_failing(celery_mode, monkeypatch):
    monkeypatch.setattr(get_settings(), "queue_warn_depth", 5)
    await queue_jobs(celery_mode, 8, "refresh")
    await celery_mode.set("breaker:abc", "1", ex=30)
    snap = await health.snapshot()
    assert snap.status == "degraded" and not snap.workers_stuck
    assert any("8 jobs queued" in r for r in snap.reasons) and snap.breakers_open == 1


async def test_default_stuck_threshold_outlasts_the_longest_query(monkeypatch):
    monkeypatch.setattr(get_settings(), "stuck_after_s", None)
    assert health.stuck_after_s() == get_settings().query_timeout_s + 60


async def test_unreachable_redis_fails_readiness(client, monkeypatch):
    dead = Redis(port=1, socket_connect_timeout=0.2)
    monkeypatch.setattr(health, "redis", lambda: dead)
    snap = await health.snapshot()
    assert snap.status == "failing" and not snap.redis and "Redis is unreachable." in snap.reasons
    res = await client.get("/readyz")
    assert res.status_code == 503 and res.json()["redis"] is False


async def test_worker_tasks_record_progress(celery_mode):
    from app.worker.celery_app import _mark_activity
    _mark_activity()
    assert time.time() - float(await celery_mode.get(health.ACTIVITY_KEY)) < 5


async def test_detailed_health_is_for_admins(user, admin):
    assert (await user.get("/api/ops/health")).status_code == 403
    body = (await admin.get("/api/ops/health")).json()
    assert body["status"] in ("ok", "degraded") and body["postgres"] and body["redis"]


async def test_inline_mode_reports_no_queue(client):
    snap = await health.snapshot()
    assert snap.queue_depth is None and not snap.workers_stuck
    assert "spendboard_queue_depth" not in (await client.get("/metrics")).text


async def held_card_job(r, age_s: float, routing_key: str = "interactive"):
    import json
    await r.hset("unacked", "tag-1", json.dumps([{"body": "…"}, "", routing_key]))
    await r.zadd("unacked_index", {"tag-1": time.time() - age_s})


@pytest.fixture
async def unacked_cleanup(celery_mode):
    yield celery_mode
    await celery_mode.delete("unacked", "unacked_index")


async def test_all_workers_stuck_on_their_jobs_with_nothing_queued(unacked_cleanup):
    # Fewer jobs than workers, every one hung: nothing waits in the queue, yet nothing progresses
    await held_card_job(unacked_cleanup, age_s=500)
    await unacked_cleanup.set(health.ACTIVITY_KEY, time.time() - 500)
    snap = await health.snapshot()
    assert snap.workers_stuck and snap.oldest_card_job_held_s >= 500
    assert "held by a worker" in snap.reasons[0]


async def test_restarted_worker_is_not_blamed_for_its_predecessors_jobs(unacked_cleanup):
    # After the platform restarts a stuck worker, Celery still lists the old held jobs for a while
    await held_card_job(unacked_cleanup, age_s=500)
    await unacked_cleanup.set(health.ACTIVITY_KEY, time.time() - 2)   # the new worker reported ready
    assert not (await health.snapshot()).workers_stuck


async def test_long_running_refresh_jobs_are_not_stuck(unacked_cleanup):
    await held_card_job(unacked_cleanup, age_s=500, routing_key="refresh")
    await unacked_cleanup.set(health.ACTIVITY_KEY, time.time() - 500)
    snap = await health.snapshot()
    assert snap.oldest_card_job_held_s is None and not snap.workers_stuck
