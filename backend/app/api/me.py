from typing import Any

from fastapi import APIRouter

from app.core.auth import CurrentUser

router = APIRouter(prefix="/api", tags=["identity"])


@router.get("/me")
async def me(user: CurrentUser) -> dict[str, Any]:
    return {"id": user.id, "sub": user.sub, "name": user.name, "email": user.email, "role": user.role}
