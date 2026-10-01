"""Offline assistant: answers common questions from the figures on screen, with no model calls.

Used when no LLM is configured (LLM_PROVIDER=offline). It reads the same dashboard context the model
would get and handles the common intents: totals, leaders, growth, concentration, and an overview."""

import re
from typing import Any

from app.assistant.agent import Answer
from app.assistant.context import CardView, DashboardContext


def money(v: float) -> str:
    sign = "-" if v < 0 else ""
    v = abs(v)
    for div, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if v >= div:
            return f"{sign}${v / div:.1f}{suffix}"
    return f"{sign}${v:,.0f}"


def pct(v: float) -> str:
    return f"{'+' if v >= 0 else ''}{v:.1f}%"


def _pairs(card: CardView) -> list[tuple[str, float]]:
    """(label, value) rows of a breakdown card."""
    out = []
    for r in card.rows:
        label = r.get("label", next((v for v in r.values() if isinstance(v, str)), None))
        value = r.get("value", next((v for v in r.values() if isinstance(v, (int, float)) and not isinstance(v, bool)), None))
        if label is not None and isinstance(value, (int, float)):
            sub = r.get("sublabel")
            out.append((f"{label} · {sub}" if sub else str(label), float(value)))
    return out


def _growth(card: CardView) -> list[tuple[str, float, float]]:
    """(label, value, % change vs prior year) for rows that existed last year."""
    prev = {}
    for r in card.meta.get("prevRows") or []:
        key = (str(r.get("label")), str(r.get("sublabel", "")))
        if isinstance(r.get("value"), (int, float)):
            prev[key] = float(r["value"])
    out = []
    for r in card.rows:
        p = prev.get((str(r.get("label")), str(r.get("sublabel", ""))))
        if p and isinstance(r.get("value"), (int, float)):
            out.append((str(r["label"]), float(r["value"]), (float(r["value"]) - p) / p * 100))
    return out


def _kpis(ctx: DashboardContext) -> list[CardView]:
    return [c for c in ctx.cards if c.chart_type == "kpi" and c.rows and isinstance(next(iter(c.rows[0].values()), None), (int, float))]


def _kpi_value(card: CardView) -> float:
    return float(next(iter(card.rows[0].values())))


def _breakdowns(ctx: DashboardContext) -> list[CardView]:
    return [c for c in ctx.cards if c.chart_type != "kpi" and _pairs(c) and c.dimension]


def _dimension_in(ctx: DashboardContext, question: str) -> str | None:
    q = question.lower()
    names = {c.dimension for c in ctx.cards if c.dimension} | {f["dimension"] for f in ctx.filter_defs if f["dimension"]}
    for name in sorted(names, key=len, reverse=True):
        words = {name, name.replace("_", " "), name.replace("_", "-")}
        if any(re.search(rf"\b{re.escape(w)}(e?s)?\b", q) for w in words):
            return name
    return None


def _filter_actions(ctx: DashboardContext, dimension: str | None, values: list[str]) -> list[dict[str, Any]]:
    f = next((f for f in ctx.filter_defs if f["kind"] != "period" and f["dimension"] == dimension), None)
    return [{"label": f"Filter to {v} →", "filter_id": f["id"], "values": [v]} for v in values] if f else []


def answer(ctx: DashboardContext, question: str) -> Answer:
    q = question.lower()
    kpis, breakdowns = _kpis(ctx), _breakdowns(ctx)
    when = f" for {ctx.filter_summary}" if ctx.filter_summary else ""

    if re.search(r"what am i looking at|what is this|explain|overview|about this dashboard", q):
        names = ", ".join(c.name for c in ctx.cards[:8]) + (" and more" if len(ctx.cards) > 8 else "")
        text = (f"{ctx.name}: {ctx.description or 'a dashboard'}. It has {len(ctx.cards)} cards — {names}. "
                f"Current filters: {ctx.filter_summary or 'none'}.")
        return Answer(text, [c.item_id for c in ctx.cards[:4]], [])

    if re.search(r"grow|growth|fastest|increas|yoy|year over year", q):
        lines, cited = [], []
        moving = [(c, c.meta["deltaPct"]) for c in kpis[1:] if "deltaPct" in c.meta] or \
                 [(c, c.meta["deltaPct"]) for c in kpis if "deltaPct" in c.meta]
        if moving:
            best, d = max(moving, key=lambda x: x[1])
            lines.append(f"Among the headline figures, {best.name} is growing fastest at {pct(d)} year over year.")
            cited.append(best.item_id)
        dim = _dimension_in(ctx, q)
        for card in [c for c in breakdowns if not dim or c.dimension == dim][:2]:
            rows = sorted(_growth(card), key=lambda r: r[2], reverse=True)[:3]
            if rows:
                lines.append(f"In {card.name}, the fastest growers are " +
                             ", ".join(f"{label} ({pct(g)})" for label, _, g in rows) + ".")
                cited.append(card.item_id)
        if lines:
            return Answer(" ".join(lines), cited, [])
        return Answer("Growth needs a period filter so the cards can compare against the prior year.", [], [])

    if re.search(r"concentrat|spread|share|distribut", q):
        dim = _dimension_in(ctx, q)
        card = next((c for c in breakdowns if c.dimension == dim), None) or max(breakdowns, key=lambda c: len(_pairs(c)), default=None)
        if card:
            pairs = sorted(_pairs(card), key=lambda p: p[1], reverse=True)
            total = sum(v for _, v in pairs) or 1
            top3 = sum(v for _, v in pairs[:3]) / total * 100
            spread = "concentrated" if top3 >= 70 else "fairly spread out"
            text = (f"In {card.name}, spend is {spread}: {pairs[0][0]} alone is {pairs[0][1] / total * 100:.1f}% and the top 3 "
                    f"make up {top3:.1f}% of {money(total)} across {len(pairs)} {(card.dimension or 'item').replace('_', ' ')} values.")
            return Answer(text, [card.item_id], [])

    top = re.search(r"top\s+(\d+)", q)
    if top or re.search(r"best|leading|largest|biggest|highest|most|performing|which", q):
        n = int(top.group(1)) if top else 3
        dim = _dimension_in(ctx, q)
        card = next((c for c in breakdowns if c.dimension == dim), None)
        if card:
            pairs = sorted(_pairs(card), key=lambda p: p[1], reverse=True)[:n]
            noun = (card.dimension or "item").replace("_", " ")
            if top:
                text = (f"Top {len(pairs)} {noun}s{when}, from {card.name}: " +
                        ", ".join(f"{i + 1}. {label} {money(v)}" for i, (label, v) in enumerate(pairs)) + ".")
            else:
                text = f"By {noun}, {pairs[0][0]} leads at {money(pairs[0][1])}" + "".join(
                    f", followed by {label} at {money(v)}" for label, v in pairs[1:3]) + f" ({card.name}{when})."
            growth = sorted(_growth(card), key=lambda r: r[2], reverse=True)
            if growth:
                text += f" Fastest growing is {growth[0][0]} at {pct(growth[0][2])} year over year."
            return Answer(text, [card.item_id], _filter_actions(ctx, card.dimension, [p[0].split(" · ")[0] for p in pairs]))
        if len(kpis) > 1:  # compare the headline figures (e.g. one KPI per segment)
            parts = sorted(kpis[1:], key=_kpi_value, reverse=True)
            text = f"By volume, {parts[0].name} leads at {money(_kpi_value(parts[0]))}" + "".join(
                f", followed by {c.name} at {money(_kpi_value(c))}" for c in parts[1:3]) + "."
            growing = [c for c in parts if "deltaPct" in c.meta]
            if growing:
                g = max(growing, key=lambda c: c.meta["deltaPct"])
                text += f" Fastest growing is {g.name} at {pct(g.meta['deltaPct'])} year over year."
            labels = [c.name.replace(" Spend", "").strip() for c in parts]
            return Answer(text, [c.item_id for c in parts], _filter_actions(ctx, dim or "segment", labels[:3]))

    if re.search(r"total|overall|how much|right now|headline", q) and kpis:
        head = kpis[0]
        text = f"{head.name} is {money(_kpi_value(head))}{when}."
        if "deltaPct" in head.meta:
            text += f" That is {pct(head.meta['deltaPct'])} year over year, a change of {money(head.meta['deltaAbs'])}."
        if len(kpis) > 1:
            text += " Breaking that down: " + ", ".join(f"{c.name} at {money(_kpi_value(c))}" for c in kpis[1:4]) + "."
        return Answer(text, [c.item_id for c in kpis[:4]], [])

    return Answer("I can answer from this dashboard's figures — totals, leaders, growth, and how concentrated spend is. "
                  "Try one of the suggestions, or set up a model (LLM_PROVIDER) for open-ended questions.", [], [])
