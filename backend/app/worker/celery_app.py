"""Celery workers: card queries (interactive queue) and background refresh/warm-up (refresh queue).

    uv run celery -A app.worker.celery_app worker -Q interactive,refresh -c 8 --loglevel=info
    uv run celery -A app.worker.celery_app beat --loglevel=info

Each worker process keeps one event loop for its lifetime, so async database pools and the Redis
client are reused across tasks.
"""

import asyncio
import sys
from typing import Any

import billiard
from celery import Celery
from celery.signals import worker_process_init

from app.core.config import get_settings

# Celery's prefork pool expects fork(); macOS defaults to spawn, which leaves worker processes
# uninitialised. Linux (Docker, production) already forks.
if sys.platform == "darwin":
    billiard.set_start_method("fork", force=True)

celery = Celery("spendboard", broker=get_settings().celery_broker_url or get_settings().redis_url)
celery.conf.update(
    task_default_queue="interactive",
    task_routes={"spendboard.refresh_rest": {"queue": "refresh"}, "spendboard.warm_dashboards": {"queue": "refresh"}},
    task_acks_late=True,               # a crashed worker's job is redelivered
    worker_prefetch_multiplier=1,      # don't let one worker hoard slow queries
    task_ignore_result=True,           # results go to the Redis result cache, not Celery's backend
    broker_connection_retry_on_startup=True,
    beat_schedule={
        # Expire with the schedule: if workers are busy, skip a round rather than queue a backlog
        "refresh-rest-extracts": {"task": "spendboard.refresh_rest", "schedule": 60.0, "options": {"expires": 60}},
        "warm-global-dashboards": {"task": "spendboard.warm_dashboards", "schedule": 300.0, "options": {"expires": 300}},
    },
)

_loop: asyncio.AbstractEventLoop | None = None


@worker_process_init.connect
def _init_loop(**_: Any) -> None:
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)


def run(coro):
    global _loop
    if _loop is None:  # e.g. solo pool / eager mode
        _init_loop()
    return _loop.run_until_complete(coro)


# Last line of defence: card jobs bound their own queries (jobs.job_deadline_s, ≤ QUERY_TIMEOUT_S + 10),
# but nothing may hold a worker process indefinitely. The soft limit raises inside the task; the hard
# limit replaces the process. Background refresh tasks are unlimited — they expire per schedule instead.
@celery.task(name="spendboard.run_card", soft_time_limit=get_settings().query_timeout_s + 60,
             time_limit=get_settings().query_timeout_s + 90)
def run_card_task(job: dict[str, Any]) -> None:
    from app.execution.queue import handle
    run(handle("run_card", job))


@celery.task(name="spendboard.refresh_rest")
def refresh_rest_task() -> int:
    from app.execution.background import refresh_rest_extracts
    return run(refresh_rest_extracts())


@celery.task(name="spendboard.warm_dashboards")
def warm_dashboards_task() -> int:
    from app.execution.background import warm_global_dashboards
    return run(warm_global_dashboards())
