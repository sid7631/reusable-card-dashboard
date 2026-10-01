from typing import Any

from fastapi import APIRouter
from sqlalchemy import or_, select

from app.core.auth import CurrentUser, Session
from app.models import User

router = APIRouter(prefix="/api", tags=["identity"])


@router.get("/users")
async def directory(user: CurrentUser, session: Session, q: str = "") -> list[dict[str, Any]]:
    """People you can share with (directory synced from the identity provider)."""
    query = select(User).where(User.sub != "system", User.id != user.id).order_by(User.name).limit(50)
    if q:
        query = query.where(or_(User.name.ilike(f"%{q}%"), User.email.ilike(f"%{q}%")))
    return [{"id": u.id, "name": u.name, "email": u.email, "role": u.role} for u in await session.scalars(query)]
