"""Fork-on-edit, change requests and PR-style approval (architecture §4.2–4.4, §4.6)."""

from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.governance.diff import diff_versions
from app.governance.labels import diff_labels
from app.governance.merge import merge3
from app.governance.service import Access, next_label, save_version
from app.models import (OPEN_STATUSES, Asset, AssetDependency, AssetVersion, AuditEvent, ChangeRequest,
                        ChangeRequestComment, ChangeRequestItem, User, version_label)


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
    # Lineage is recorded before the first version is saved: save-time checks (e.g. reusing a data
    # source's stored credential against the same endpoint) rely on it
    fork = Asset(kind=asset.kind, scope="private", owner_id=user.id, name=head.name, description=head.description,
                 forked_from_asset_id=asset.id, forked_from_version_id=head.id)
    session.add(fork)
    await session.flush()
    await save_version(session, user, fork, name=head.name, description=head.description, spec=head.spec,
                       change_note=f"Copied from global v{head.label}", carry_from=[head])
    session.add(AuditEvent(actor_id=user.id, action="asset.forked", asset_id=fork.id,
                           payload={"from_asset_id": asset.id, "from_version_no": head.version_no,
                                    "from_version": head.label}))
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
        "base_version": base.label, "global_version": theirs.label,
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
    # Track the new base first: the merged version is numbered after it (global v5 → 5.1). It is saved
    # even when the content is unchanged (every conflict kept "mine"), so the copy's number says
    # which global version it is now based on
    fork.forked_from_version_id = preview["theirs_version_id"]
    kept = " — kept my changes" if merged == snapshot(head) else ""
    version = await save_version(session, user, fork, name=merged["name"], description=merged["description"],
                                 spec=merged["spec"], change_note=f"Updated from global v{preview['global_version']}{kept}",
                                 carry_from=[await session.get(AssetVersion, preview["theirs_version_id"])])
    # An open request for this copy now proposes the merged version against the new base
    for item in await session.scalars(
        select(ChangeRequestItem).join(ChangeRequest, ChangeRequest.id == ChangeRequestItem.request_id).where(
            ChangeRequest.status.in_(OPEN_STATUSES), ChangeRequestItem.source_asset_id == fork.id)):
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


async def _item_fields(session: AsyncSession, asset: Asset) -> dict[str, Any]:
    target = await session.get(Asset, asset.forked_from_asset_id) if asset.forked_from_asset_id else None
    if target is not None and target.archived_at is None:
        return {"type": "update_existing", "target_asset_id": target.id, "base_version_id": asset.forked_from_version_id}
    # New — or a copy whose global original was deleted: it would come back as a new global asset
    return {"type": "publish_new", "target_asset_id": None, "base_version_id": None}


async def _check_not_pending(session: AsyncSession, assets: list[Asset], exclude_request: int | None = None) -> None:
    query = (select(ChangeRequest.id, Asset.name).select_from(ChangeRequest)
             .join(ChangeRequestItem, ChangeRequestItem.request_id == ChangeRequest.id)
             .join(Asset, Asset.id == ChangeRequestItem.source_asset_id)
             .where(ChangeRequest.status.in_(OPEN_STATUSES), ChangeRequestItem.source_asset_id.in_([a.id for a in assets])))
    if exclude_request is not None:
        query = query.where(ChangeRequest.id != exclude_request)
    clash = (await session.execute(query.limit(1))).first()
    if clash:
        raise HTTPException(status.HTTP_409_CONFLICT, f"“{clash.name}” is already in review (request #{clash.id}).")


async def _add_items(session: AsyncSession, request: ChangeRequest, assets: list[Asset]) -> None:
    for position, asset in enumerate(assets):
        session.add(ChangeRequestItem(request_id=request.id, position=position, source_asset_id=asset.id,
                                      source_version_id=asset.head_version_id, **await _item_fields(session, asset)))


async def _unchanged_copy(session: AsyncSession, asset: Asset) -> AssetVersion | None:
    """The global version this copy still matches exactly (None: new, changed, or the original is gone)."""
    target = await session.get(Asset, asset.forked_from_asset_id) if asset.forked_from_asset_id else None
    if target is None or target.archived_at is not None:
        return None
    base = await session.get(AssetVersion, asset.forked_from_version_id)
    head = await session.get(AssetVersion, asset.head_version_id)
    return base if snapshot(head) == snapshot(base) else None


async def submit(session: AsyncSession, user: User, asset: Asset, level: Access, title: str, description: str) -> ChangeRequest:
    if asset.scope != "private" or level != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner of a private asset can submit it for review.")
    bundle = await _closure(session, user, asset)
    unchanged = [await _unchanged_copy(session, a) for a in bundle]
    if all(unchanged):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Nothing to propose: “{asset.name}” is the same as global v{unchanged[-1].label}. Make a change first.")
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
async def _lock(session: AsyncSession, request: ChangeRequest) -> None:
    """Decide on a request one at a time: a second approve/reject arriving together waits for the first,
    then sees its outcome (otherwise both pass the status check and publish twice)."""
    await session.execute(select(ChangeRequest.id).where(ChangeRequest.id == request.id).with_for_update())
    await session.refresh(request)


def _require_open(request: ChangeRequest) -> None:
    if request.status not in OPEN_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Request is already {request.status}.")


def _require_in_review(request: ChangeRequest) -> None:
    _require_open(request)
    if request.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Changes were requested — the requester sends it back for review when it's ready.")


def _timeline(session: AsyncSession, user: User, request: ChangeRequest, kind: str, body: str = "") -> None:
    session.add(ChangeRequestComment(request_id=request.id, author_id=user.id, kind=kind, body=body.strip()))


async def add_comment(session: AsyncSession, user: User, request: ChangeRequest, body: str) -> None:
    """A message on the request — reviewer and requester talk without approving or rejecting."""
    if not body.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Write a message first.")
    _timeline(session, user, request, "comment", body)


async def request_changes(session: AsyncSession, admin: User, request: ChangeRequest, note: str) -> None:
    """Not yet: send the request back to the requester, open, with what to change."""
    await _lock(session, request)
    _require_in_review(request)
    if not note.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say what should change.")
    request.status = "changes_requested"
    _timeline(session, admin, request, "changes_requested", note)
    session.add(AuditEvent(actor_id=admin.id, action="request.changes_requested", request_id=request.id,
                           asset_id=request.root_asset_id, payload={"comment": note}))


async def resubmit(session: AsyncSession, user: User, request: ChangeRequest, note: str = "") -> None:
    """The requester sends it back for review, with their latest versions."""
    await _lock(session, request)
    if request.status != "changes_requested":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a request with changes requested can be sent back.")
    await resync(session, user, request)
    request.status = "pending"
    _timeline(session, user, request, "resubmitted", note)


async def evaluate(session: AsyncSession, item: ChangeRequestItem) -> dict[str, Any]:
    """What an item proposes, and how it merges with the current global head."""
    source = await session.get(AssetVersion, item.source_version_id)
    asset = await session.get(Asset, item.source_asset_id)
    out: dict[str, Any] = {"id": item.id, "type": item.type, "kind": asset.kind, "position": item.position,
                           "source_asset_id": asset.id, "source_version_no": source.version_no,
                           "source_version": source.label, "name": source.name,
                           "result_version_id": item.result_version_id}
    result = await _version(session, item.result_version_id)
    if result is not None:
        out["result_version"] = result.label
    base_spec = (await _version(session, item.base_version_id)).spec if item.base_version_id else {}
    out["labels"] = await diff_labels(session, base_spec, source.spec)
    if item.type == "publish_new":
        return {**out, "changes": diff_versions({}, snapshot(source)), "conflicts": [], "stale": False,
                "unchanged": False, "merged": snapshot(source), "suggested_major": 1, "min_major": 1}

    target = await session.get(Asset, item.target_asset_id)
    base = await _version(session, item.base_version_id)
    head = await session.get(AssetVersion, target.head_version_id)
    merged, conflicts = merge3(snapshot(base), snapshot(source), snapshot(head))
    # Deleted after the request was sent: nothing to update — it can't be approved as is
    out["target_deleted"] = target.archived_at is not None
    suggested, _ = await next_label(session, target)
    return {**out, "target_asset_id": target.id, "target_name": target.name,
            "base_version_no": base.version_no, "global_version_no": head.version_no,
            "base_version": base.label, "global_version": head.label,
            # The version approval publishes; an admin may pick a higher one
            "suggested_major": suggested, "min_major": suggested,
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


async def approve(session: AsyncSession, admin: User, request: ChangeRequest, comment: str,
                  versions: dict[int, int] | None = None) -> None:
    """Publish every item. `versions` maps item id → the global version to publish it as (default:
    the next one); items that publish nothing new ignore it."""
    await _lock(session, request)
    _require_in_review(request)
    items = list(await session.scalars(select(ChangeRequestItem).where(ChangeRequestItem.request_id == request.id)
                                       .order_by(ChangeRequestItem.position)))
    evaluated = [await evaluate(session, i) for i in items]
    deleted = [e["target_name"] for e in evaluated if e.get("target_deleted")]
    if deleted:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"The global {', '.join(f'“{n}”' for n in deleted)} was deleted, so there is nothing to update. "
                            "Reject the request, or restore it first.")
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
        source_version = await session.get(AssetVersion, item.source_version_id)
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
                                         description=merged["description"], spec=spec, change_note=note,
                                         major=(versions or {}).get(item.id), carry_from=[source_version])
        else:
            target = Asset(kind=source_asset.kind, scope="global", owner_id=None, name=merged["name"],
                           description=merged["description"])
            session.add(target)
            await session.flush()
            version = await save_version(session, requester, target, name=merged["name"],
                                         description=merged["description"], spec=spec, change_note=note,
                                         major=(versions or {}).get(item.id), carry_from=[source_version])
            source_asset.forked_from_asset_id = target.id
        # The private copy now tracks the published version, so later edits are proposed as updates
        source_asset.forked_from_version_id = version.id
        item.result_version_id = version.id
        mapping[source_asset.id] = (target.id, version.id)

    request.status, request.reviewed_by, request.review_comment = "approved", admin.id, comment
    request.decided_at = datetime.now(UTC)
    _timeline(session, admin, request, "approved", comment)
    session.add(AuditEvent(actor_id=admin.id, action="request.approved", request_id=request.id,
                           asset_id=request.root_asset_id, payload={"comment": comment}))


async def reject(session: AsyncSession, admin: User, request: ChangeRequest, comment: str) -> None:
    await _lock(session, request)
    _require_open(request)
    if not comment.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say why the request is rejected.")
    request.status, request.reviewed_by, request.review_comment = "rejected", admin.id, comment
    request.decided_at = datetime.now(UTC)
    _timeline(session, admin, request, "rejected", comment)
    session.add(AuditEvent(actor_id=admin.id, action="request.rejected", request_id=request.id,
                           asset_id=request.root_asset_id, payload={"comment": comment}))


async def withdraw(session: AsyncSession, user: User, request: ChangeRequest) -> None:
    await _lock(session, request)
    _require_open(request)
    if request.requested_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can withdraw this request.")
    request.status, request.decided_at = "withdrawn", datetime.now(UTC)
    _timeline(session, user, request, "withdrawn")
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
        .where(ChangeRequest.status.in_(OPEN_STATUSES), ChangeRequestItem.source_asset_id.in_(ids)))).all())

    forks = [a for a in assets if a.forked_from_asset_id]
    targets = {t.id: t for t in await session.scalars(
        select(Asset).where(Asset.id.in_({a.forked_from_asset_id for a in forks})))} if forks else {}
    version_ids = {a.forked_from_version_id for a in forks} | {t.head_version_id for t in targets.values()}
    found = (await session.execute(select(AssetVersion.id, AssetVersion.version_no, AssetVersion.major,
                                          AssetVersion.minor).where(AssetVersion.id.in_(version_ids)))).all() if forks else []
    numbers = {vid: no for vid, no, *_ in found}
    labels = {vid: version_label(major, minor) for vid, _no, major, minor in found}

    # Global assets: open requests that would change them ("2 open requests are changing this card")
    proposals: dict[int, list[dict[str, Any]]] = {}
    for target_id, req_id, requester in (await session.execute(
            select(ChangeRequestItem.target_asset_id, ChangeRequest.id, User.name)
            .join(ChangeRequest, ChangeRequest.id == ChangeRequestItem.request_id)
            .join(User, User.id == ChangeRequest.requested_by)
            .where(ChangeRequest.status.in_(OPEN_STATUSES), ChangeRequestItem.target_asset_id.in_(ids))
            .order_by(ChangeRequest.id))).all():
        proposals.setdefault(target_id, []).append({"id": req_id, "requested_by_name": requester})

    out = {}
    for a in assets:
        fork = None
        target = targets.get(a.forked_from_asset_id) if a.forked_from_asset_id else None
        if target is not None and target.archived_at is not None:
            fork = {"asset_id": target.id, "name": target.name, "deleted": True, "stale": False,
                    "base_version_no": numbers.get(a.forked_from_version_id), "global_version_no": None,
                    "base_version": labels.get(a.forked_from_version_id), "global_version": None}
        elif target is not None:
            fork = {"asset_id": target.id, "name": target.name, "deleted": False,
                    "base_version_no": numbers.get(a.forked_from_version_id),
                    "global_version_no": numbers.get(target.head_version_id),
                    "base_version": labels.get(a.forked_from_version_id),
                    "global_version": labels.get(target.head_version_id),
                    "stale": a.forked_from_version_id != target.head_version_id}
        out[a.id] = {"pending_request_id": pending.get(a.id), "fork": fork, "open_requests": proposals.get(a.id, [])}
    return out


# ---------------------------------------------------------------- what depends on an asset
async def asset_usage(session: AsyncSession, user: User, asset: Asset) -> dict[str, Any]:
    """What deleting this asset affects: assets whose current version uses it, private copies of it and
    open requests about it. Other people's private assets are counted, not named."""
    dependents = (await session.execute(
        select(Asset, User.name).join(AssetDependency, AssetDependency.version_id == Asset.head_version_id)
        .outerjoin(User, User.id == Asset.owner_id)
        .where(AssetDependency.depends_on_asset_id == asset.id, Asset.archived_at.is_(None))
        .order_by(Asset.scope.desc(), Asset.name))).all()
    shown, hidden = [], 0
    for dep, owner in dependents:
        if dep.scope == "global" or dep.owner_id == user.id:
            shown.append({"id": dep.id, "kind": dep.kind, "name": dep.name, "scope": dep.scope, "owner_name": owner})
        else:
            hidden += 1
    copies = await session.scalar(select(func.count()).select_from(Asset).where(
        Asset.forked_from_asset_id == asset.id, Asset.scope == "private", Asset.archived_at.is_(None)))
    requests = (await session.execute(
        select(ChangeRequest.id, ChangeRequest.title, User.name).distinct()
        .join(ChangeRequestItem, ChangeRequestItem.request_id == ChangeRequest.id)
        .join(User, User.id == ChangeRequest.requested_by)
        .where(ChangeRequest.status.in_(OPEN_STATUSES),
               (ChangeRequestItem.target_asset_id == asset.id) | (ChangeRequestItem.source_asset_id == asset.id))
        .order_by(ChangeRequest.id))).all()
    return {"used_by": shown, "used_by_others": hidden, "copies": copies,
            "open_requests": [{"id": i, "title": t, "requested_by_name": n} for i, t, n in requests]}
