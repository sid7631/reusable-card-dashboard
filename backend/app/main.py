from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from app.api import assistant, cards, change_requests, dashboards, data_sources, demo, me, ops, semantic, users
from app.core import redis as redis_client
from app.api.asset_routes import asset_router
from app.connectors import postgres
from app.connectors.common import QueryError
from app.core.db import engine
from app.execution.sql import SqlValidationError
from app.ops import health
from app.semantic.filters import FilterError
from app.semantic.query import CompileError


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await postgres.close_pools()
    await redis_client.close()
    await engine.dispose()


app = FastAPI(title="SpendBoard API", version="0.2.0", lifespan=lifespan)

for router in (me.router, users.router, data_sources.router, cards.router, dashboards.router, change_requests.router,
               semantic.router, ops.router, assistant.router, demo.router,
               asset_router("card", "/api/cards"), asset_router("dashboard", "/api/dashboards"),
               asset_router("data_source", "/api/data-sources")):
    app.include_router(router)


# User-facing query problems are 400s with a readable message, not server errors
@app.exception_handler(SqlValidationError)
@app.exception_handler(FilterError)
@app.exception_handler(CompileError)
@app.exception_handler(QueryError)
async def query_error(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# Probes and metrics live outside /api: the web server only forwards /api, so they are reachable
# inside the deployment (platform probes, Prometheus) but not from the public site.
@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, str]:
    """Liveness: the API process is up."""
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
async def readyz() -> JSONResponse:
    """Readiness: this API can serve requests (Postgres and Redis reachable). Deliberately ignores
    stuck workers — failing readiness for those would take the whole app offline (see app.ops.check)."""
    snap = await health.snapshot()
    ready = snap.postgres and snap.redis
    return JSONResponse(status_code=200 if ready else 503,
                        content={"status": "ready" if ready else "not ready", "postgres": snap.postgres, "redis": snap.redis})


@app.get("/metrics", include_in_schema=False, response_class=PlainTextResponse)
async def metrics() -> PlainTextResponse:
    """Prometheus metrics: health status, queue depth, worker progress, breakers, cache and latency."""
    return PlainTextResponse(await health.metrics_text(), media_type="text/plain; version=0.0.4")
