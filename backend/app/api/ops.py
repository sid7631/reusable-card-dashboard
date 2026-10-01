from typing import Any

from fastapi import APIRouter, HTTPException, status

from app.core.auth import CurrentUser
from app.execution import jobs

router = APIRouter(prefix="/api/ops", tags=["operations"])


@router.get("/stats")
async def stats(user: CurrentUser) -> dict[str, Any]:
    """Result-cache hit ratio, computations, errors and compute latency (admins)."""
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admins only.")
    return await jobs.stats()
