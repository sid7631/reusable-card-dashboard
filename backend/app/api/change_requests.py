from typing import Annotated, Any, Literal

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, func, select, true
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.auth import CurrentUser, Session
from app.execution.cards import run_card
from app.semantic.filters import Filters
from app.governance import requests as cr
from app.governance.service import MAX_MAJOR, get_asset
from app.governance.specs import CardSpec, DataSourceSpec
from app.models import (OPEN_STATUSES, Asset, AssetVersion, ChangeRequest, ChangeRequestComment, ChangeRequestItem,
                        ChangeRequestRead, User)

router = APIRouter(prefix="/api/change-requests", tags=["change requests"])

KIND_PATHS = {"cards": "card", "dashboards": "dashboard", "data-sources": "data_source"}


class SubmitIn(BaseModel):
    kind: Literal["cards", "dashboards", "data-sources"]
    asset_id: int
    title: str = Field(min_length=1, max_length=200)
    description: str = ""


class DecisionIn(BaseModel):
    comment: str = ""


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=5000)


class ApproveIn(DecisionIn):
    # Item id → global version to publish it as, overriding the suggested next version
    versions: dict[int, Annotated[int, Field(ge=1, le=MAX_MAJOR)]] = {}


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can review change requests.")


async def _load(session: AsyncSession, user: User, request_id: int) -> ChangeRequest:
    request = await session.get(ChangeRequest, request_id)
    if request is None or (user.role != "admin" and request.requested_by != user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Change request not found.")
    return request


async def _detail(session: AsyncSession, user: User, request: ChangeRequest) -> dict[str, Any]:
    items = list(await session.scalars(select(ChangeRequestItem).where(ChangeRequestItem.request_id == request.id)
                                       .order_by(ChangeRequestItem.position)))
    evaluated = [{k: v for k, v in (await cr.evaluate(session, i)).items() if k != "merged"} for i in items]
    is_open = request.status in OPEN_STATUSES
    if not is_open:
        # Staleness and conflicts only matter while a request is open
        for e in evaluated:
            e.update(stale=False, conflicts=[])
    else:
        # Other open requests changing the same global asset: approving one can conflict the others
        others = await _open_requests_by_target(session, {i.target_asset_id for i in items} - {None}, request.id)
        for item, e in zip(items, evaluated, strict=True):
            e["also_affects"] = others.get(item.target_asset_id, [])
    names = dict((await session.execute(select(User.id, User.name).where(
        User.id.in_({request.requested_by, request.reviewed_by} - {None})))).all())
    has_conflicts = any(e["conflicts"] for e in evaluated)
    in_review = request.status == "pending"
    admin, requester = user.role == "admin", request.requested_by == user.id
    return {
        **_summary(request, names),
        "items": evaluated,
        "comments": await _timeline(session, request),
        "has_conflicts": has_conflicts,
        "is_requester": requester,
        "can_approve": in_review and admin and not has_conflicts and not any(e.get("target_deleted") for e in evaluated),
        "can_request_changes": in_review and admin,
        "can_reject": is_open and admin,
        "can_withdraw": is_open and requester,
        "can_update": is_open and requester,
        "can_resubmit": request.status == "changes_requested" and requester,
        "can_comment": admin or requester,
    }


async def _timeline(session: AsyncSession, request: ChangeRequest) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(ChangeRequestComment, User.name, User.role).join(User, User.id == ChangeRequestComment.author_id)
        .where(ChangeRequestComment.request_id == request.id).order_by(ChangeRequestComment.created_at, ChangeRequestComment.id))
    return [{"id": c.id, "kind": c.kind, "body": c.body, "author_id": c.author_id, "author_name": name,
             "author_role": role, "created_at": c.created_at.isoformat()} for c, name, role in rows.all()]


async def _open_requests_by_target(session: AsyncSession, target_ids: set[int],
                                   exclude: int) -> dict[int, list[dict[str, Any]]]:
    if not target_ids:
        return {}
    out: dict[int, list[dict[str, Any]]] = {}
    for target_id, req_id, title, requester in (await session.execute(
            select(ChangeRequestItem.target_asset_id, ChangeRequest.id, ChangeRequest.title, User.name)
            .join(ChangeRequest, ChangeRequest.id == ChangeRequestItem.request_id)
            .join(User, User.id == ChangeRequest.requested_by)
            .where(ChangeRequest.status.in_(OPEN_STATUSES), ChangeRequest.id != exclude,
                   ChangeRequestItem.target_asset_id.in_(target_ids)).order_by(ChangeRequest.id))).all():
        out.setdefault(target_id, []).append({"id": req_id, "title": title, "requested_by_name": requester})
    return out


def _unread(user: User) -> ColumnElement[int]:
    """Comments by others on a request since this user last opened it (a correlated count)."""
    read = (select(ChangeRequestRead.last_read_at).where(ChangeRequestRead.request_id == ChangeRequest.id,
                                                         ChangeRequestRead.user_id == user.id)
            .correlate(ChangeRequest).scalar_subquery())
    return (select(func.count()).select_from(ChangeRequestComment)
            .where(ChangeRequestComment.request_id == ChangeRequest.id, ChangeRequestComment.author_id != user.id,
                   ChangeRequestComment.created_at > func.coalesce(read, datetime(1970, 1, 1, tzinfo=UTC)))
            .correlate(ChangeRequest).scalar_subquery())


async def _mark_read(session: AsyncSession, user: User, request: ChangeRequest) -> None:
    now = datetime.now(UTC)
    await session.execute(insert(ChangeRequestRead).values(request_id=request.id, user_id=user.id, last_read_at=now)
                          .on_conflict_do_update(index_elements=["request_id", "user_id"], set_={"last_read_at": now}))


def _summary(request: ChangeRequest, names: dict[int, str], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": request.id, "status": request.status, "title": request.title, "description": request.description,
        "requested_by": request.requested_by, "requested_by_name": names.get(request.requested_by),
        "reviewed_by": request.reviewed_by, "reviewed_by_name": names.get(request.reviewed_by),
        "review_comment": request.review_comment, "root_asset_id": request.root_asset_id,
        "created_at": request.created_at.isoformat(),
        "decided_at": request.decided_at.isoformat() if request.decided_at else None,
        **(extra or {}),
    }


@router.get("")
async def list_requests(user: CurrentUser, session: Session,
                        status_: Literal["pending", "changes_requested", "open", "approved", "rejected", "withdrawn", "all"]
                        = Query("all", alias="status"),
                        mine: bool = False) -> list[dict[str, Any]]:
    """Admins see every request (the approval queue); users see their own."""
    requester, reviewer = aliased(User), aliased(User)
    root = aliased(Asset)
    item_count = (select(func.count()).where(ChangeRequestItem.request_id == ChangeRequest.id)
                  .correlate(ChangeRequest).scalar_subquery())
    query = (select(ChangeRequest, requester.name, reviewer.name, root.kind, root.name, item_count, _unread(user))
             .join(requester, requester.id == ChangeRequest.requested_by)
             .outerjoin(reviewer, reviewer.id == ChangeRequest.reviewed_by)
             .join(root, root.id == ChangeRequest.root_asset_id)
             .order_by(ChangeRequest.created_at.desc()).limit(200))
    if status_ == "open":
        query = query.where(ChangeRequest.status.in_(OPEN_STATUSES))
    elif status_ != "all":
        query = query.where(ChangeRequest.status == status_)
    if mine or user.role != "admin":
        query = query.where(ChangeRequest.requested_by == user.id)
    return [
        _summary(r, {r.requested_by: req_name, r.reviewed_by: rev_name},
                 {"root_kind": kind, "root_name": name, "item_count": n, "unread": unread})
        for r, req_name, rev_name, kind, name, n, unread in (await session.execute(query)).all()
    ]


@router.get("/summary")
async def summary(user: CurrentUser, session: Session) -> dict[str, int]:
    """Sidebar badges. pending: the review queue (admins) or own open requests (users); action_needed:
    own requests sent back with changes requested; unread: new messages on requests the user can see."""
    mine = ChangeRequest.requested_by == user.id
    visible = true() if user.role == "admin" else mine
    count = lambda *where: session.scalar(select(func.count()).select_from(ChangeRequest).where(*where))  # noqa: E731
    pending = await count(visible, ChangeRequest.status == "pending" if user.role == "admin"
                          else ChangeRequest.status.in_(OPEN_STATUSES))
    action_needed = await count(mine, ChangeRequest.status == "changes_requested")
    unread = await session.scalar(select(func.coalesce(func.sum(_unread(user)), 0)).select_from(ChangeRequest).where(visible))
    return {"pending": pending, "action_needed": action_needed, "unread": int(unread)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def submit(body: SubmitIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    asset, level = await get_asset(session, user, KIND_PATHS[body.kind], body.asset_id)
    request = await cr.submit(session, user, asset, level, body.title, body.description)
    await session.commit()
    return await _detail(session, user, request)


@router.get("/{request_id}")
async def get_request(request_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    request = await _load(session, user, request_id)
    await _mark_read(session, user, request)  # opening the request reads its conversation
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/comments", status_code=status.HTTP_201_CREATED)
async def comment(request_id: int, body: CommentIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    request = await _load(session, user, request_id)
    await cr.add_comment(session, user, request, body.body)
    await _mark_read(session, user, request)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/request-changes")
async def request_changes(request_id: int, body: DecisionIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    _require_admin(user)
    request = await _load(session, user, request_id)
    await cr.request_changes(session, user, request, body.comment)
    await _mark_read(session, user, request)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/resubmit")
async def resubmit(request_id: int, body: DecisionIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    request = await _load(session, user, request_id)
    await cr.resubmit(session, user, request, body.comment)
    await _mark_read(session, user, request)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/update")
async def update_request(request_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    request = await _load(session, user, request_id)
    await cr.resync(session, user, request)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/approve")
async def approve(request_id: int, body: ApproveIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    _require_admin(user)
    request = await _load(session, user, request_id)
    await cr.approve(session, user, request, body.comment, body.versions)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/reject")
async def reject(request_id: int, body: DecisionIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    _require_admin(user)
    request = await _load(session, user, request_id)
    await cr.reject(session, user, request, body.comment)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/withdraw")
async def withdraw(request_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    request = await _load(session, user, request_id)
    await cr.withdraw(session, user, request)
    await session.commit()
    return await _detail(session, user, request)


@router.get("/{request_id}/items/{item_id}/data")
async def preview_item(request_id: int, item_id: int, user: CurrentUser, session: Session,
                       segment: str | None = None, sub_segments: str | None = None,
                       date_from: str | None = Query(None, alias="from"),
                       date_to: str | None = Query(None, alias="to"), filters: str | None = None) -> dict[str, Any]:
    """Render a proposed card version for review (the reviewer may not otherwise see the private card)."""
    request = await _load(session, user, request_id)
    item = await session.get(ChangeRequestItem, item_id)
    if item is None or item.request_id != request.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    version = await session.get(AssetVersion, item.source_version_id)
    if (await session.get(Asset, item.source_asset_id)).kind != "card":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Only card items can be previewed.")
    card = CardSpec.model_validate(version.spec)
    source = DataSourceSpec.model_validate((await session.get(AssetVersion, card.data_source.version_id)).spec)
    return {"chart_type": card.chart_type, "config": card.config,
            **await run_card(card, source, Filters.parse(segment, sub_segments, date_from, date_to, filters))}
