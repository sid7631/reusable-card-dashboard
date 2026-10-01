"""Fork-on-edit, change requests and PR-style approval (architecture §4.2–4.4, §4.6)."""

from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.governance.diff import diff_versions
from app.governance.merge import merge3
from app.governance.service import Access, create_asset, save_version
from app.models import Asset, AssetDependency, AssetVersion, AuditEvent, ChangeRequest, ChangeRequestItem, User


def snapshot(v: AssetVersion | None) -> dict[str, Any]:
    return {} if v is None else {"name": v.name, "description": v.description, "spec": v.spec}


async def _version(session: AsyncSession, version_id: int | None) -> AssetVersion | None:
    return await session.get(AssetVersion, version_id) if version_id else None


# ---------------------------------------------------------------- fork & update-from-global
async def find_fork(session: AsyncSession, user: User, asset: Asset) -> Asset | None:
    return await session.scalar(select(Asset).where(
        Asset.forked_from_asset_id == asset.id, Asset.owner_id == user.id, Asset.scope == "private",
        Asset.archived_at.is_(None)).order_by(Asset.id.desc()).limit(1))


async def fork_asset(session: AsyncSession, user: User, asset: Asset) -> tuple[Asset, bool]:
    """Private working copy of a global asset. Reuses the user's existing copy if there is one."""
    if asset.scope != "global":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only global assets are forked — edit private assets directly.")
    existing = await find_fork(session, user, asset)
    if existing is not None:
        return existing, False
    head = await session.get(AssetVersion, asset.head_version_id)
    fork, _ = await create_asset(session, user, asset.kind, name=head.name, description=head.description, spec=head.spec)
    fork.forked_from_asset_id, fork.forked_from_version_id = asset.id, head.id
    session.add(AuditEvent(actor_id=user.id, action="asset.forked", asset_id=fork.id,
                           payload={"from_asset_id": asset.id, "from_version_no": head.version_no}))
    return fork, True


async def _fork_parts(session: AsyncSession, fork: Asset) -> tuple[Asset, AssetVersion, AssetVersion, AssetVersion]:
    target = await session.get(Asset, fork.forked_from_asset_id) if fork.forked_from_asset_id else None
    if target is None or target.scope != "global" or target.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This asset is not a copy of a live global asset.")
    base = await session.get(AssetVersion, fork.forked_from_version_id)
    ours = await session.get(AssetVersion, fork.head_version_id)
    theirs = await session.get(AssetVersion, target.head_version_id)
    return target, base, ours, theirs


async def rebase_preview(session: AsyncSession, fork: Asset, resolutions: dict[str, str] | None = None) -> dict[str, Any]:
    target, base, ours, theirs = await _fork_parts(session, fork)
    merged, conflicts = merge3(snapshot(base), snapshot(ours), snapshot(theirs), resolutions)
    return {
        "global_asset_id": target.id, "base_version_no": base.version_no, "global_version_no": theirs.version_no,
        "stale": base.id != theirs.id, "conflicts": conflicts,
        "incoming": diff_versions(snapshot(base), snapshot(theirs)),     # what changed globally since the fork
        "result": diff_versions(snapshot(ours), merged),                 # what applying it does to your copy
        "merged": merged, "theirs_version_id": theirs.id,
    }


async def rebase(session: AsyncSession, user: User, fork: Asset, resolutions: dict[str, str]) -> AssetVersion | None:
    """'Update from global': merge global changes into the private copy, like merging main into a PR branch."""
    preview = await rebase_preview(session, fork, resolutions)
    if not preview["stale"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "Your copy is already up to date with global.")
    if preview["conflicts"]:
        raise HTTPException(status.HTTP_409_CONFLICT, {"message": "Resolve every conflict first.",
                                                       "conflicts": preview["conflicts"]})
    merged = preview["merged"]
    head = await session.get(AssetVersion, fork.head_version_id)
    version = None
    if merged != snapshot(head):
        version = await save_version(session, user, fork, name=merged["name"], description=merged["description"],
                                     spec=merged["spec"], change_note=f"Updated from global v{preview['global_version_no']}")
    fork.forked_from_version_id = preview["theirs_version_id"]
    # An open request for this copy now proposes the merged version against the new base
    for item in await session.scalars(
        select(ChangeRequestItem).join(ChangeRequest, ChangeRequest.id == ChangeRequestItem.request_id).where(
            ChangeRequest.status == "pending", ChangeRequestItem.source_asset_id == fork.id)):
        item.source_version_id = fork.head_version_id
        item.base_version_id = fork.forked_from_version_id
    return version


# ---------------------------------------------------------------- submitting
async def _closure(session: AsyncSession, user: User, root: Asset) -> list[Asset]:
    """Root plus its private dependencies, dependencies first (data sources → cards → dashboards)."""
    ordered: list[Asset] = []
    seen: set[int] = set()

    async def visit(asset: Asset) -> None:
        if asset.id in seen:
            return
        seen.add(asset.id)
        dep_ids = await session.scalars(select(AssetDependency.depends_on_asset_id)
                                        .where(AssetDependency.version_id == asset.head_version_id))
        for dep_id in dep_ids.all():
            dep = await session.get(Asset, dep_id)
            if dep.scope == "private":
                if dep.owner_id != user.id:
                    raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                        f"“{dep.name}” belongs to someone else — ask its owner to publish it first.")
                await visit(dep)
        ordered.append(asset)

    await visit(root)
    return ordered


def _item_fields(asset: Asset) -> dict[str, Any]:
    if asset.forked_from_asset_id:
        return {"type": "update_existing", "target_asset_id": asset.forked_from_asset_id,
                "base_version_id": asset.forked_from_version_id}
    return {"type": "publish_new", "target_asset_id": None, "base_version_id": None}


async def _check_not_pending(session: AsyncSession, assets: list[Asset], exclude_request: int | None = None) -> None:
    query = (select(ChangeRequest.id, Asset.name).select_from(ChangeRequest)
             .join(ChangeRequestItem, ChangeRequestItem.request_id == ChangeRequest.id)
             .join(Asset, Asset.id == ChangeRequestItem.source_asset_id)
             .where(ChangeRequest.status == "pending", ChangeRequestItem.source_asset_id.in_([a.id for a in assets])))
    if exclude_request is not None:
        query = query.where(ChangeRequest.id != exclude_request)
    clash = (await session.execute(query.limit(1))).first()
    if clash:
        raise HTTPException(status.HTTP_409_CONFLICT, f"“{clash.name}” is already in review (request #{clash.id}).")


async def _add_items(session: AsyncSession, request: ChangeRequest, assets: list[Asset]) -> None:
    for position, asset in enumerate(assets):
        session.add(ChangeRequestItem(request_id=request.id, position=position, source_asset_id=asset.id,
                                      source_version_id=asset.head_version_id, **_item_fields(asset)))


async def submit(session: AsyncSession, user: User, asset: Asset, level: Access, title: str, description: str) -> ChangeRequest:
    if asset.scope != "private" or level != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner of a private asset can submit it for review.")
    bundle = await _closure(session, user, asset)
    await _check_not_pending(session, bundle)
    request = ChangeRequest(title=title, description=description, requested_by=user.id, root_asset_id=asset.id)
    session.add(request)
    await session.flush()
    await _add_items(session, request, bundle)
    session.add(AuditEvent(actor_id=user.id, action="request.submitted", asset_id=asset.id, request_id=request.id,
                           payload={"items": len(bundle)}))
    return request


async def resync(session: AsyncSession, user: User, request: ChangeRequest) -> None:
    """Push the latest versions of the submitted assets to an open request (like pushing to a PR branch)."""
    _require_open(request)
    if request.requested_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can update this request.")
    root = await session.get(Asset, request.root_asset_id)
    bundle = await _closure(session, user, root)
    await _check_not_pending(session, bundle, exclude_request=request.id)
    for item in await session.scalars(select(ChangeRequestItem).where(ChangeRequestItem.request_id == request.id)):
        await session.delete(item)
    await session.flush()
    await _add_items(session, request, bundle)
    session.add(AuditEvent(actor_id=user.id, action="request.updated", request_id=request.id))


# ---------------------------------------------------------------- reviewing
def _require_open(request: ChangeRequest) -> None:
    if request.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Request is already {request.status}.")


async def evaluate(session: AsyncSession, item: ChangeRequestItem) -> dict[str, Any]:
    """What an item proposes, and how it merges with the current global head."""
    source = await session.get(AssetVersion, item.source_version_id)
    asset = await session.get(Asset, item.source_asset_id)
    out: dict[str, Any] = {"id": item.id, "type": item.type, "kind": asset.kind, "position": item.position,
                           "source_asset_id": asset.id, "source_version_no": source.version_no, "name": source.name,
                           "result_version_id": item.result_version_id}
    if item.type == "publish_new":
        return {**out, "changes": diff_versions({}, snapshot(source)), "conflicts": [], "stale": False,
                "unchanged": False, "merged": snapshot(source)}

    target = await session.get(Asset, item.target_asset_id)
    base = await _version(session, item.base_version_id)
    head = await session.get(AssetVersion, target.head_version_id)
    merged, conflicts = merge3(snapshot(base), snapshot(source), snapshot(head))
    return {**out, "target_asset_id": target.id, "target_name": target.name,
            "base_version_no": base.version_no, "global_version_no": head.version_no,
            "stale": base.id != head.id, "unchanged": snapshot(source) == snapshot(base),
            "changes": diff_versions(snapshot(base), snapshot(source)),
            "conflicts": conflicts, "merged": merged}


def _rewrite_refs(kind: str, spec: dict[str, Any], mapping: dict[int, tuple[int, int]]) -> dict[str, Any]:
    """Point references at the global assets created/updated by this request."""
    def remap(ref: dict[str, int]) -> dict[str, int]:
        hit = mapping.get(ref["asset_id"])
        return {"asset_id": hit[0], "version_id": hit[1]} if hit else ref

    if kind == "card":
        return {**spec, "data_source": remap(spec["data_source"])}
    if kind == "dashboard":
        return {**spec, "items": [{**i, "card": remap(i["card"])} for i in spec.get("items", [])]}
    return spec


async def approve(session: AsyncSession, admin: User, request: ChangeRequest, comment: str) -> None:
    _require_open(request)
    items = list(await session.scalars(select(ChangeRequestItem).where(ChangeRequestItem.request_id == request.id)
                                       .order_by(ChangeRequestItem.position)))
    evaluated = [await evaluate(session, i) for i in items]
    conflicted = [e["name"] for e in evaluated if e["conflicts"]]
    if conflicted:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Conflicts with the current global version in: {', '.join(conflicted)}. "
                            "The requester must update from global first.")

    requester = await session.get(User, request.requested_by)
    note = f"{request.title} (request #{request.id})"
    mapping: dict[int, tuple[int, int]] = {}
    for item, ev in zip(items, evaluated, strict=True):
        source_asset = await session.get(Asset, item.source_asset_id)
        merged = ev["merged"]
        spec = _rewrite_refs(source_asset.kind, merged["spec"], mapping)

        if item.type == "update_existing":
            target = await session.get(Asset, item.target_asset_id)
            head = await session.get(AssetVersion, target.head_version_id)
            # Nothing new to publish: an untouched copy maps to the exact version it was copied from,
            # and a result identical to global maps to the global head — no duplicate versions
            reuse = (item.base_version_id if ev["unchanged"]
                     else head.id if {**merged, "spec": spec} == snapshot(head) else None)
            if reuse is not None:
                mapping[source_asset.id] = (target.id, reuse)
                item.result_version_id = reuse
                continue
            version = await save_version(session, requester, target, name=merged["name"],
                                         description=merged["description"], spec=spec, change_note=note)
        else:
            target = Asset(kind=source_asset.kind, scope="global", owner_id=None, name=merged["name"],
                           description=merged["description"])
            session.add(target)
            await session.flush()
            version = await save_version(session, requester, target, name=merged["name"],
                                         description=merged["description"], spec=spec, change_note=note)
            source_asset.forked_from_asset_id = target.id
        # The private copy now tracks the published version, so later edits are proposed as updates
        source_asset.forked_from_version_id = version.id
        item.result_version_id = version.id
        mapping[source_asset.id] = (target.id, version.id)

    request.status, request.reviewed_by, request.review_comment = "approved", admin.id, comment
    request.decided_at = datetime.now(UTC)
    session.add(AuditEvent(actor_id=admin.id, action="request.approved", request_id=request.id,
                           asset_id=request.root_asset_id, payload={"comment": comment}))


async def reject(session: AsyncSession, admin: User, request: ChangeRequest, comment: str) -> None:
    _require_open(request)
    if not comment.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say why the request is rejected.")
    request.status, request.reviewed_by, request.review_comment = "rejected", admin.id, comment
    request.decided_at = datetime.now(UTC)
    session.add(AuditEvent(actor_id=admin.id, action="request.rejected", request_id=request.id,
                           asset_id=request.root_asset_id, payload={"comment": comment}))


async def withdraw(session: AsyncSession, user: User, request: ChangeRequest) -> None:
    _require_open(request)
    if request.requested_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can withdraw this request.")
    request.status, request.decided_at = "withdrawn", datetime.now(UTC)
    session.add(AuditEvent(actor_id=user.id, action="request.withdrawn", request_id=request.id))


# ---------------------------------------------------------------- per-asset governance info
async def governance_info(session: AsyncSession, assets: list[Asset]) -> dict[int, dict[str, Any]]:
    """Pending request and fork lineage for each asset — drives the UI's propose/update affordances."""
    ids = [a.id for a in assets]
    if not ids:
        return {}
    pending = dict((await session.execute(
        select(ChangeRequestItem.source_asset_id, ChangeRequest.id)
        .join(ChangeRequest, ChangeRequest.id == ChangeRequestItem.request_id)
        .where(ChangeRequest.status == "pending", ChangeRequestItem.source_asset_id.in_(ids)))).all())

    forks = [a for a in assets if a.forked_from_asset_id]
    targets = {t.id: t for t in await session.scalars(
        select(Asset).where(Asset.id.in_({a.forked_from_asset_id for a in forks})))} if forks else {}
    version_ids = {a.forked_from_version_id for a in forks} | {t.head_version_id for t in targets.values()}
    numbers = dict((await session.execute(
        select(AssetVersion.id, AssetVersion.version_no).where(AssetVersion.id.in_(version_ids)))).all()) if forks else {}

    out = {}
    for a in assets:
        fork = None
        target = targets.get(a.forked_from_asset_id) if a.forked_from_asset_id else None
        if target is not None and target.archived_at is None:
            fork = {"asset_id": target.id, "name": target.name,
                    "base_version_no": numbers.get(a.forked_from_version_id),
                    "global_version_no": numbers.get(target.head_version_id),
                    "stale": a.forked_from_version_id != target.head_version_id}
        out[a.id] = {"pending_request_id": pending.get(a.id), "fork": fork}
    return out
