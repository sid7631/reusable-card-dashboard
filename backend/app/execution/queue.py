"""The one place that hands work to a queue (architecture §8).

Everything else — caching, single-flight locks, result delivery over Redis pub/sub — is independent
of the queue, so swapping the transport only means another backend here plus a consumer process.

    inline  run in this process (tests, single-process demos)
    celery  Celery workers; the broker is CELERY_BROKER_URL (Redis by default, or RabbitMQ / SQS)

A job is a JSON-serialisable dict that carries everything a worker needs (no database reads for the
card or source definition). Delivery is at-least-once and that is safe: a duplicate just recomputes
the same cache entry. A new backend therefore needs only:

    1. `submit(task, payload, queue, expires_s)` that publishes the payload (and drops it if stale)
    2. a consumer that calls `handle(task, payload)` for each message and acks after it returns
"""

import asyncio
from typing import Any

from app.core.config import get_settings

_inline_tasks: set[asyncio.Task] = set()


async def handle(task: str, payload: dict[str, Any]) -> None:
    """Run one job. Any consumer — Celery task, queue listener — ends up here."""
    if task == "run_card":
        from app.execution.jobs import Job, compute
        await compute(Job(**payload))
    else:
        raise ValueError(f"Unknown task {task!r}")


async def submit(task: str, payload: dict[str, Any], *, queue: str = "interactive", expires_s: float | None = None) -> None:
    """`expires_s`: discard the job if no worker has started it by then (no-op inline)."""
    mode = get_settings().execution_mode
    if mode == "inline":
        t = asyncio.create_task(handle(task, payload))
        _inline_tasks.add(t)
        t.add_done_callback(_inline_tasks.discard)
    elif mode == "celery":
        from app.worker.celery_app import celery
        await asyncio.to_thread(celery.send_task, f"spendboard.{task}", args=[payload], queue=queue, expires=expires_s)
    else:
        raise ValueError(f"Unknown EXECUTION_MODE {mode!r}")
