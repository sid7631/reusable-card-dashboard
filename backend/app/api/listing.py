from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.governance.service import visible_to
from app.models import Asset, AssetShare, AssetVersion, User


def access_for(asset: Asset, user: User, share_permission: str | None) -> str | None:
    if asset.scope == "global":
        return "admin" if user.role == "admin" else "view"
    if asset.owner_id == user.id:
        return "owner"
    return share_permission


async def list_visible(session: AsyncSession, user: User, kind: str, scope: str | None = None) -> list[tuple[Asset, AssetVersion, str | None, str | None]]:
    """(asset, head version, owner name, access) for every asset of `kind` the user can see."""
    query: Select[Any] = (
        select(Asset, AssetVersion, User.name, AssetShare.permission)
        .join(AssetVersion, Asset.head_version_id == AssetVersion.id)
        .outerjoin(User, Asset.owner_id == User.id)
        .outerjoin(AssetShare, (AssetShare.asset_id == Asset.id) & (AssetShare.grantee_type == "user")
                   & (AssetShare.grantee_id == user.id))
        .where(Asset.kind == kind, visible_to(user))
        .order_by(Asset.scope.desc(), Asset.updated_at.desc())
    )
    if scope == "global":
        query = query.where(Asset.scope == "global")
    elif scope == "private":
        query = query.where(Asset.scope == "private", Asset.owner_id == user.id)
    elif scope == "shared":
        query = query.where(Asset.scope == "private", Asset.owner_id != user.id)
    rows = (await session.execute(query)).all()
    return [(a, v, owner, access_for(a, user, perm)) for a, v, owner, perm in rows]


async def owner_name(session: AsyncSession, asset: Asset) -> str | None:
    return await session.scalar(select(User.name).where(User.id == asset.owner_id)) if asset.owner_id else None


async def versions_of(session: AsyncSession, asset_id: int) -> list[tuple[AssetVersion, str]]:
    rows = await session.execute(
        select(AssetVersion, User.name).join(User, AssetVersion.created_by == User.id)
        .where(AssetVersion.asset_id == asset_id).order_by(AssetVersion.version_no.desc())
    )
    return [(v, n) for v, n in rows.all()]
