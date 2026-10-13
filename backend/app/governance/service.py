"""Versioning, visibility and permission rules shared by every asset kind (architecture §4)."""

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import HTTPException, status
from pydantic import BaseModel, ValidationError
from sqlalchemy import ColumnElement, and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.governance.specs import SPEC_MODELS, dependencies
from app.models import (OPEN_STATUSES, Asset, AssetDependency, AssetShare, AssetVersion, AuditEvent, ChangeRequest,
                        ChangeRequestComment, ChangeRequestItem, User)

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
    if permission is None and user.role == "admin" and await _submitted_for_review(session, asset.id):
        # Reviewers may open what was submitted to them (read-only); it still isn't listed for them
        return "view"
    return permission  # type: ignore[return-value]


async def _submitted_for_review(session: AsyncSession, asset_id: int) -> bool:
    return bool(await session.scalar(select(exists().where(ChangeRequestItem.source_asset_id == asset_id))))


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
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                            exc.errors(include_url=False, include_context=False, include_input=False)) from exc


async def _kept_versions(session: AsyncSession, asset: Asset, carry_from: list[AssetVersion]) -> set[int]:
    """Versions already referenced by the asset's current head or by the versions being carried over
    (restored, copied, published) — a deleted card or source may stay where it already was."""
    ids = [v.id for v in carry_from] + ([asset.head_version_id] if asset.head_version_id else [])
    if not ids:
        return set()
    return set(await session.scalars(select(AssetDependency.depends_on_version_id)
                                     .where(AssetDependency.version_id.in_(ids))))


async def _check_dependencies(session: AsyncSession, user: User, asset: Asset, spec: BaseModel,
                              carry_from: list[AssetVersion]) -> list[AssetVersion]:
    resolved = []
    kept: set[int] | None = None
    for ref in dependencies(asset.kind, spec):
        version = await session.get(AssetVersion, ref.version_id)
        dep = await session.get(Asset, ref.asset_id)
        if version is None or dep is None or version.asset_id != dep.id or dep.kind != DEPENDENCY_KIND[asset.kind]:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Invalid reference {ref.model_dump()}.")
        # References the asset already has (or that are carried over) stay without re-checking: an editor
        # of a shared dashboard may not have access to every card the owner put on it
        kept = kept if kept is not None else await _kept_versions(session, asset, carry_from)
        if dep.archived_at is not None:
            # Deleted: existing uses keep working (pinned versions), but it can't be added anywhere new
            if version.id not in kept:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                    f"“{dep.name}” was deleted — it can't be added. Choose another {dep.kind.replace('_', ' ')}.")
        elif version.id not in kept and await access_level(session, user, dep) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"No access to referenced {dep.kind} {dep.id}.")
        if asset.scope == "global" and dep.scope != "global":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"A global {asset.kind.replace('_', ' ')} can't use the private {dep.kind.replace('_', ' ')} “{dep.name}” — publish it first.",
            )
        resolved.append(version)
    return resolved


# Highest version an admin may choose (the column is a 32-bit integer; real versions stay far below)
MAX_MAJOR = 99_999


async def next_label(session: AsyncSession, asset: Asset) -> tuple[int, int]:
    """(major, minor) the next save of this asset gets.

    Global assets count whole versions: 1, 2, 3… A private copy is numbered after the global version
    it tracks — a copy of global v3 saves 3.1, 3.2, … and after "update from global" to v5, 5.1, … A
    private asset that was never published saves 0.1, 0.2, …"""
    if asset.scope == "global":
        top = await session.scalar(select(func.max(AssetVersion.major)).where(AssetVersion.asset_id == asset.id))
        return (top or 0) + 1, 0
    base = await session.get(AssetVersion, asset.forked_from_version_id) if asset.forked_from_version_id else None
    major = base.major if base is not None else 0
    top = await session.scalar(select(func.max(AssetVersion.minor)).where(
        AssetVersion.asset_id == asset.id, AssetVersion.major == major))
    return major, (top or 0) + 1


async def save_version(
    session: AsyncSession, user: User, asset: Asset, *, name: str, description: str,
    spec: dict[str, Any], change_note: str = "", major: int | None = None,
    carry_from: list[AssetVersion] | None = None,
) -> AssetVersion:
    """Append a new immutable version and move the asset's head to it. Caller commits.

    `major` overrides the suggested version of a global asset (it must be higher than every existing one).
    `carry_from`: versions whose references (even to since-deleted assets) this save may keep — e.g.
    the version being restored, copied or published."""
    parsed = parse_spec(asset.kind, spec)
    deps = await _check_dependencies(session, user, asset, parsed, carry_from or [])
    if asset.kind == "data_source":
        from app.connectors.policy import check_data_source  # connectors depend on governance specs
        await check_data_source(session, user, asset, parsed)

    # Serialise concurrent saves of the same asset so version numbers stay gapless
    await session.execute(select(Asset.id).where(Asset.id == asset.id).with_for_update())
    current = await session.scalar(select(func.max(AssetVersion.version_no)).where(AssetVersion.asset_id == asset.id))
    suggested, minor = await next_label(session, asset)
    if major is not None and major > MAX_MAJOR:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Versions go up to v{MAX_MAJOR:,}.")
    if major is not None and major != suggested:
        if asset.scope != "global":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Only global versions can be numbered by hand.")
        if major < suggested:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                f"“{name}” is already at v{suggested - 1} — choose v{suggested} or higher.")

    version = AssetVersion(
        asset_id=asset.id, version_no=(current or 0) + 1, major=major or suggested, minor=minor,
        name=name, description=description,
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
                           payload={"version_no": version.version_no, "version": version.label,
                                    "change_note": change_note}))
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
    # Open requests that would publish it can't go ahead: withdraw them, saying why in their conversation
    in_request = select(ChangeRequestItem.request_id).where(ChangeRequestItem.source_asset_id == asset.id)
    for request in await session.scalars(
            select(ChangeRequest).where(ChangeRequest.status.in_(OPEN_STATUSES), ChangeRequest.id.in_(in_request))
            .with_for_update()):
        request.status, request.decided_at = "withdrawn", datetime.now(UTC)
        session.add(ChangeRequestComment(request_id=request.id, author_id=user.id, kind="withdrawn",
                                         body=f"Withdrawn automatically: “{asset.name}” was deleted."))
        session.add(AuditEvent(actor_id=user.id, action="request.withdrawn", request_id=request.id,
                               payload={"reason": "source deleted", "asset_id": asset.id}))


async def restore_version(session: AsyncSession, user: User, asset: Asset, version: AssetVersion) -> AssetVersion:
    """Restoring never rewrites history: it appends a new version carrying the old content."""
    if version.id == asset.head_version_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "That version is already current.")
    return await save_version(session, user, asset, name=version.name, description=version.description,
                              spec=version.spec, change_note=f"Restored v{version.label}", carry_from=[version])


async def undelete_asset(session: AsyncSession, user: User, asset: Asset) -> None:
    """Bring back a deleted asset as it was. Global: admins; private: the owner."""
    allowed = user.role == "admin" if asset.scope == "global" else asset.owner_id == user.id
    if asset.archived_at is None or not allowed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{asset.kind.replace('_', ' ').capitalize()} not found.")
    asset.archived_at = None
    session.add(AuditEvent(actor_id=user.id, action="asset.restored", asset_id=asset.id))


# ---------------------------------------------------------------- sharing
def _require_owner(asset: Asset, level: Access) -> None:
    if asset.scope == "global":
        raise HTTPException(status.HTTP_409_CONFLICT, "Global assets are visible to everyone — sharing applies to private assets.")
    if level != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner can change sharing.")


async def set_share(session: AsyncSession, user: User, asset: Asset, level: Access, grantee_id: int,
                    permission: str) -> AssetShare:
    _require_owner(asset, level)
    grantee = await session.get(User, grantee_id)
    if grantee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if grantee.id == user.id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "You already own this asset.")
    share = await session.get(AssetShare, (asset.id, "user", grantee.id))
    if share is None:
        share = AssetShare(asset_id=asset.id, grantee_type="user", grantee_id=grantee.id, permission=permission,
                           granted_by=user.id)
        session.add(share)
    else:
        share.permission = permission
    session.add(AuditEvent(actor_id=user.id, action="share.granted", asset_id=asset.id,
                           payload={"grantee_id": grantee.id, "permission": permission}))
    return share


async def remove_share(session: AsyncSession, user: User, asset: Asset, level: Access, grantee_id: int) -> None:
    _require_owner(asset, level)
    share = await session.get(AssetShare, (asset.id, "user", grantee_id))
    if share is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not shared with that user.")
    await session.delete(share)
    session.add(AuditEvent(actor_id=user.id, action="share.revoked", asset_id=asset.id, payload={"grantee_id": grantee_id}))
