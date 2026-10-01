import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.assistant import agent, llm, offline
from app.assistant.context import build_context
from app.core.auth import CurrentUser, Session
from app.core.redis import redis
from app.governance.service import get_asset
from app.models import AuditEvent

router = APIRouter(prefix="/api", tags=["assistant"])


class ShownItem(BaseModel):
    """A card as currently shown: its effective filters (same shape as /render)."""
    item_id: str
    filters: dict[str, list[str]] = {}
    date_from: str | None = None
    date_to: str | None = None


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default_factory=list, max_length=40)
    items: list[ShownItem] = Field(default_factory=list, max_length=200)
    # Human-readable filters, e.g. "Total AXP · 2026 YTD"
    filter_summary: str = Field("", max_length=300)


@router.get("/assistant/config")
async def config(user: CurrentUser) -> dict[str, Any]:
    return {"mode": "offline" if llm.provider() == "offline" else "llm", "provider": llm.provider(), "model": llm.model_label()}


@router.post("/dashboards/{dashboard_id}/assistant")
async def ask(dashboard_id: int, body: AskIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Answer a question about the dashboard as the user sees it, citing the cards used."""
    from app.core.config import get_settings

    asset, _ = await get_asset(session, user, "dashboard", dashboard_id)
    bucket = f"assistant:{user.id}:{int(time.time() // 60)}"
    if await redis().incr(bucket) > get_settings().assistant_requests_per_minute:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many questions — wait a minute and try again.")
    await redis().expire(bucket, 90)

    ctx = await build_context(session, asset, [i.model_dump() for i in body.items], body.filter_summary)
    mode = "offline" if llm.provider() == "offline" else "llm"
    if mode == "offline":
        result = offline.answer(ctx, body.question)
    else:
        try:
            result = await agent.ask(ctx, body.question, [t.model_dump() for t in body.history])
        except llm.AssistantUnavailable as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    session.add(AuditEvent(actor_id=user.id, action="assistant.asked", asset_id=asset.id,
                           payload={"mode": mode, "question_chars": len(body.question),
                                    "tools": [t["tool"] for t in result.trace]}))
    await session.commit()
    names = {c.item_id: c.name for c in ctx.cards}
    return {
        "answer": result.text,
        "sources": [{"item_id": i, "name": names[i]} for i in result.cited_items if i in names],
        "actions": result.actions,
        "mode": mode,
        "model": llm.model_label(),
        "tool_calls": [{"tool": t["tool"], "args": t["args"]} for t in result.trace],
    }
