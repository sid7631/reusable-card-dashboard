from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import cards, change_requests, dashboards, data_sources, me, users
from app.api.asset_routes import asset_router
from app.connectors import postgres
from app.core.db import engine
from app.execution.sql import SqlValidationError


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await postgres.close_pools()
    await engine.dispose()


app = FastAPI(title="SpendBoard API", version="0.2.0", lifespan=lifespan)

for router in (me.router, users.router, data_sources.router, cards.router, dashboards.router, change_requests.router,
               asset_router("card", "/api/cards"), asset_router("dashboard", "/api/dashboards"),
               asset_router("data_source", "/api/data-sources")):
    app.include_router(router)


# User-facing query problems are 400s with a readable message, not server errors
@app.exception_handler(SqlValidationError)
@app.exception_handler(postgres.QueryError)
async def query_error(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
