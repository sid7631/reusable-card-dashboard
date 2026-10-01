"""Versioning, visibility and permission rules shared by every asset kind (architecture §4)."""

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import HTTPException, status
from pydantic import BaseModel, ValidationError
from sqlalchemy import ColumnElement, and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.governance.specs import SPEC_MODELS, dependencies
from app.models import Asset, AssetDependency, AssetShare, AssetVersion, AuditEvent, User

Access = Literal["admin", "owner", "edit", "view"]
WRITE_ACCESS: frozenset[str] = frozenset({"admin", "owner", "edit"})

# Which kind each kind may reference
DEPENDENCY_KIND = {"card": "data_source", "dashboard": "card"}


def visible_to(user: User) -> ColumnElement[bool]:
    """Global assets, the user's own private assets, and private assets shared with them."""
    share = aliased(AssetShare)  # callers may also join AssetShare; keep this subquery independent
    shared = exists().where(share.asset_id == Asset.id, share.grantee_type == "user", share.grantee_id == user.id)
    return and_(Asset.archived_at.is_(None), or_(Asset.scope == "global", Asset.owner_id == user.id, shared))


async def access_level(session: AsyncSession, user: User, asset: Asset) -> Access | None:
    if asset.archived_at is not None:
        return None
    if asset.scope == "global":
        return "admin" if user.role == "admin" else "view"
    if asset.owner_id == user.id:
        return "owner"
    permission = await session.scalar(
        select(AssetShare.permission).where(
            AssetShare.asset_id == asset.id, AssetShare.grantee_type == "user", AssetShare.grantee_id == user.id,
        )
    )
    return permission  # type: ignore[return-value]


async def get_asset(
    session: AsyncSession, user: User, kind: str, asset_id: int, *, write: bool = False,
) -> tuple[Asset, Access]:
    asset = await session.get(Asset, asset_id)
    level = await access_level(session, user, asset) if asset is not None and asset.kind == kind else None
    if level is None:
        # Not found and not visible look the same, so private assets don't leak
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{kind.replace('_', ' ').capitalize()} not found.")
    if write and level not in WRITE_ACCESS:
        detail = ("Global assets are read-only — fork to a private copy to propose changes."
                  if asset.scope == "global" else "You have view-only access.")
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail)
    return asset, level


def parse_spec(kind: str, raw: dict[str, Any]) -> BaseModel:
    try:
        return SPEC_MODELS[kind].model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.errors(include_url=False)) from exc


async def _check_dependencies(session: AsyncSession, user: User, asset: Asset, spec: BaseModel) -> list[AssetVersion]:
    resolved = []
    for ref in dependencies(asset.kind, spec):
        version = await session.get(AssetVersion, ref.version_id)
        dep = await session.get(Asset, ref.asset_id)
        if version is None or dep is None or version.asset_id != dep.id or dep.kind != DEPENDENCY_KIND[asset.kind]:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Invalid reference {ref.model_dump()}.")
        if await access_level(session, user, dep) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"No access to referenced {dep.kind} {dep.id}.")
        if asset.scope == "global" and dep.scope != "global":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"A global {asset.kind} cannot depend on private {dep.kind} “{dep.name}” — publish it first.",
            )
        resolved.append(version)
    return resolved


async def save_version(
    session: AsyncSession, user: User, asset: Asset, *, name: str, description: str,
    spec: dict[str, Any], change_note: str = "",
) -> AssetVersion:
    """Append a new immutable version and move the asset's head to it. Caller commits."""
    parsed = parse_spec(asset.kind, spec)
    deps = await _check_dependencies(session, user, asset, parsed)

    # Serialise concurrent saves of the same asset so version numbers stay gapless
    await session.execute(select(Asset.id).where(Asset.id == asset.id).with_for_update())
    current = await session.scalar(select(func.max(AssetVersion.version_no)).where(AssetVersion.asset_id == asset.id))

    version = AssetVersion(
        asset_id=asset.id, version_no=(current or 0) + 1, name=name, description=description,
        spec=parsed.model_dump(mode="json"), change_note=change_note, created_by=user.id,
    )
    session.add(version)
    await session.flush()
    session.add_all(
        AssetDependency(version_id=version.id, depends_on_version_id=d.id, depends_on_asset_id=d.asset_id)
        for d in {d.id: d for d in deps}.values()
    )
    asset.head_version_id = version.id
    asset.name, asset.description = name, description
    asset.updated_at = datetime.now(UTC)
    session.add(AuditEvent(actor_id=user.id, action="version.created", asset_id=asset.id, version_id=version.id,
                           payload={"version_no": version.version_no, "change_note": change_note}))
    return version


async def create_asset(
    session: AsyncSession, user: User, kind: str, *, name: str, description: str,
    spec: dict[str, Any], scope: str = "private",
) -> tuple[Asset, AssetVersion]:
    if scope == "global" and user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can create global assets directly.")
    asset = Asset(kind=kind, scope=scope, owner_id=user.id if scope == "private" else None,
                  name=name, description=description)
    session.add(asset)
    await session.flush()
    session.add(AuditEvent(actor_id=user.id, action="asset.created", asset_id=asset.id, payload={"scope": scope}))
    version = await save_version(session, user, asset, name=name, description=description, spec=spec,
                                 change_note="Created")
    return asset, version


async def archive_asset(session: AsyncSession, user: User, asset: Asset, level: Access) -> None:
    if level not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner (or an admin, for global assets) can delete.")
    asset.archived_at = datetime.now(UTC)
    session.add(AuditEvent(actor_id=user.id, action="asset.archived", asset_id=asset.id))
