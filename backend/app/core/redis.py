"""Redis access. Clients are bound to an event loop, so one is kept per loop (API, workers, tests)."""

import asyncio

from redis.asyncio import Redis

from app.core.config import get_settings

_clients: dict[int, Redis] = {}


def redis() -> Redis:
    loop = asyncio.get_running_loop()
    client = _clients.get(id(loop))
    if client is None:
        client = Redis.from_url(get_settings().redis_url, decode_responses=True, health_check_interval=30)
        _clients[id(loop)] = client
    return client


async def close() -> None:
    loop_id = id(asyncio.get_running_loop())
    client = _clients.pop(loop_id, None)
    if client is not None:
        await client.aclose()
