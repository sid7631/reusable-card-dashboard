from typing import Any

from fastapi import APIRouter, HTTPException, status

from app.core.auth import CurrentUser
from app.execution import jobs
from app.ops import health

router = APIRouter(prefix="/api/ops", tags=["operations"])


@router.get("/stats")
async def stats(user: CurrentUser) -> dict[str, Any]:
    """Result-cache hit ratio, computations, errors and compute latency (admins)."""
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admins only.")
    return await jobs.stats()


@router.get("/health")
async def health_detail(user: CurrentUser) -> dict[str, Any]:
    """Full health snapshot with reasons (admins). Probes use /readyz and app.ops.check instead."""
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admins only.")
    return (await health.snapshot()).public()
