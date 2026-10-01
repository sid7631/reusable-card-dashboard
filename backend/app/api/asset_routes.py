"""History, restore, diff and sharing — identical for every asset kind, so built once per kind."""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.listing import versions_of
from app.api.serializers import version_out
from app.core.auth import CurrentUser, Session
from app.governance.diff import diff_versions
from app.governance.requests import fork_asset, rebase, rebase_preview
from app.governance.service import get_asset, remove_share, restore_version, set_share
from app.models import AssetShare, AssetVersion, User


class ShareIn(BaseModel):
    permission: Literal["view", "edit"]


class RebaseIn(BaseModel):
    # Conflict path -> which side to keep
    resolutions: dict[str, Literal["ours", "theirs"]] = {}


def asset_router(kind: str, prefix: str) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[f"{kind.replace('_', ' ')} governance"])

    async def version_by_no(session, asset_id: int, version_no: int) -> AssetVersion:
        version = await session.scalar(select(AssetVersion).where(
            AssetVersion.asset_id == asset_id, AssetVersion.version_no == version_no))
        if version is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Version v{version_no} not found.")
        return version

    @router.get("/{asset_id}/versions")
    async def list_versions(asset_id: int, user: CurrentUser, session: Session) -> list[dict[str, Any]]:
        asset, _ = await get_asset(session, user, kind, asset_id)
        return [{**version_out(v, author), "is_head": v.id == asset.head_version_id}
                for v, author in await versions_of(session, asset.id)]

    @router.get("/{asset_id}/versions/{version_no}")
    async def get_version(asset_id: int, version_no: int, user: CurrentUser, session: Session) -> dict[str, Any]:
        asset, _ = await get_asset(session, user, kind, asset_id)
        version = await version_by_no(session, asset.id, version_no)
        author = await session.scalar(select(User.name).where(User.id == version.created_by))
        return {**version_out(version, author), "description": version.description, "spec": version.spec,
                "is_head": version.id == asset.head_version_id}

    @router.get("/{asset_id}/diff")
    async def diff(asset_id: int, user: CurrentUser, session: Session,
                   from_no: int, to_no: int | None = None) -> dict[str, Any]:
        """Changes going from version `from_no` to `to_no` (default: current head)."""
        asset, _ = await get_asset(session, user, kind, asset_id)
        before = await version_by_no(session, asset.id, from_no)
        after = (await version_by_no(session, asset.id, to_no) if to_no
                 else await session.get(AssetVersion, asset.head_version_id))
        snapshot = lambda v: {"name": v.name, "description": v.description, "spec": v.spec}  # noqa: E731
        return {"from": before.version_no, "to": after.version_no,
                "changes": diff_versions(snapshot(before), snapshot(after)),
                "labels": await _item_labels(session, before, after)}

    @router.post("/{asset_id}/restore/{version_no}")
    async def restore(asset_id: int, version_no: int, user: CurrentUser, session: Session) -> dict[str, Any]:
        asset, _ = await get_asset(session, user, kind, asset_id, write=True)
        version = await restore_version(session, user, asset, await version_by_no(session, asset.id, version_no))
        await session.commit()
        return {**version_out(version, user.name), "is_head": True}

    @router.get("/{asset_id}/shares")
    async def list_shares(asset_id: int, user: CurrentUser, session: Session) -> list[dict[str, Any]]:
        asset, _ = await get_asset(session, user, kind, asset_id)
        rows = await session.execute(
            select(AssetShare, User).join(User, User.id == AssetShare.grantee_id)
            .where(AssetShare.asset_id == asset.id, AssetShare.grantee_type == "user").order_by(User.name))
        return [{"user_id": u.id, "name": u.name, "email": u.email, "permission": s.permission,
                 "created_at": s.created_at.isoformat()} for s, u in rows.all()]

    @router.put("/{asset_id}/shares/{user_id}")
    async def share(asset_id: int, user_id: int, body: ShareIn, user: CurrentUser, session: Session) -> dict[str, Any]:
        asset, level = await get_asset(session, user, kind, asset_id)
        s = await set_share(session, user, asset, level, user_id, body.permission)
        await session.commit()
        return {"user_id": s.grantee_id, "permission": s.permission}

    @router.delete("/{asset_id}/shares/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def unshare(asset_id: int, user_id: int, user: CurrentUser, session: Session) -> Response:
        asset, level = await get_asset(session, user, kind, asset_id)
        await remove_share(session, user, asset, level, user_id)
        await session.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post("/{asset_id}/fork")
    async def fork(asset_id: int, user: CurrentUser, session: Session, response: Response) -> dict[str, Any]:
        """Edit a global asset: returns the caller's private copy (created on first use)."""
        asset, _ = await get_asset(session, user, kind, asset_id)
        copy, created = await fork_asset(session, user, asset)
        await session.commit()
        response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
        return {"id": copy.id, "created": created}

    @router.get("/{asset_id}/rebase")
    async def rebase_check(asset_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
        """Preview 'update from global' for a private copy: incoming changes and conflicts."""
        asset, _ = await get_asset(session, user, kind, asset_id)
        preview = await rebase_preview(session, asset)
        return {k: v for k, v in preview.items() if k not in ("merged", "theirs_version_id")}

    @router.post("/{asset_id}/rebase")
    async def rebase_apply(asset_id: int, body: RebaseIn, user: CurrentUser, session: Session) -> dict[str, Any]:
        asset, _ = await get_asset(session, user, kind, asset_id, write=True)
        version = await rebase(session, user, asset, body.resolutions)
        await session.commit()
        return {"version_no": version.version_no if version else None}

    return router


async def _item_labels(session, *versions: AssetVersion) -> dict[str, str]:
    """Dashboard diffs key placements by item_id; map those ids to card names for display."""
    items = {i["item_id"]: i["card"]["version_id"] for v in versions for i in v.spec.get("items", [])}
    if not items:
        return {}
    names = dict((await session.execute(
        select(AssetVersion.id, AssetVersion.name).where(AssetVersion.id.in_(set(items.values()))))).all())
    return {item_id: names.get(version_id, "card") for item_id, version_id in items.items()}
