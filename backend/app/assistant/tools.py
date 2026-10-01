"""Tools the assistant's model may call. They run server-side with the asking user's access and are
scoped to the dashboard: queries go only to sources its cards use, results are aggregated and
row-capped, and nothing writes — a filter suggestion is applied only if the user clicks it."""

import json
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from app.assistant.context import DashboardContext
from app.execution.cards import run_query
from app.execution.jobs import USER_ERRORS, get_result, make_job
from app.semantic.filters import Filters
from app.semantic.options import dimension_values
from app.semantic.query import SemanticQuery

MAX_QUERY_ROWS = 50

_FILTERS_SCHEMA = {
    "type": "object",
    "description": "Dimension filters as {dimension_name: [values]}.",
    "additionalProperties": {"type": "array", "items": {"type": "string"}},
}
_DATE = {"type": ["string", "null"], "description": "YYYY-MM-DD, or null for no bound."}

TOOLS: list[dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "query_data",
        "description": ("Run an aggregate query against one of this dashboard's data sources, using measures and "
                        "dimensions from its semantic catalog. Use when the cards on screen don't already answer the "
                        f"question. Returns at most {MAX_QUERY_ROWS} rows."),
        "parameters": {"type": "object", "additionalProperties": False,
                       "required": ["source", "dataset", "measures"],
                       "properties": {
                           "source": {"type": "string", "description": "Source key from the catalog, e.g. s1."},
                           "dataset": {"type": "string"},
                           "measures": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 4,
                                        "description": "Measure names from the catalog."},
                           "dimensions": {"type": "array", "items": {"type": "string"}, "maxItems": 2},
                           "time_grain": {"type": ["string", "null"], "enum": ["day", "week", "month", "quarter", "year", None],
                                          "description": "Only when grouping by the time dimension."},
                           "filters": _FILTERS_SCHEMA, "date_from": _DATE, "date_to": _DATE,
                           "order": {"type": ["string", "null"], "enum": ["value_desc", "value_asc", "label_asc", "label_desc", None]},
                           "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": MAX_QUERY_ROWS},
                       }}}},
    {"type": "function", "function": {
        "name": "list_dimension_values",
        "description": "Valid values of a dimension in a source (e.g. to spell a merchant or segment correctly).",
        "parameters": {"type": "object", "additionalProperties": False, "required": ["source", "dimension"],
                       "properties": {"source": {"type": "string"}, "dimension": {"type": "string"},
                                      "search": {"type": ["string", "null"]}}}}},
    {"type": "function", "function": {
        "name": "get_card",
        "description": "Re-run one of the dashboard's cards with different filters or dates (e.g. for a comparison).",
        "parameters": {"type": "object", "additionalProperties": False, "required": ["item_id"],
                       "properties": {"item_id": {"type": "string"}, "filters": _FILTERS_SCHEMA,
                                      "date_from": _DATE, "date_to": _DATE}}}},
    {"type": "function", "function": {
        "name": "suggest_filter",
        "description": ("Offer the user a button that applies a dashboard filter (e.g. 'Filter to GCS'). Only for "
                        "filters listed in the dashboard's filter definitions. Nothing changes unless the user clicks."),
        "parameters": {"type": "object", "additionalProperties": False, "required": ["filter_id", "values", "label"],
                       "properties": {"filter_id": {"type": "string"},
                                      "values": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                                      "label": {"type": "string", "description": "Button text, e.g. 'Filter to GCS'."}}}}},
]


@dataclass
class ToolState:
    """What the tools touched — becomes the answer's citations and action buttons."""
    cited_items: list[str] = field(default_factory=list)
    actions: list[dict[str, Any]] = field(default_factory=list)
    trace: list[dict[str, Any]] = field(default_factory=list)


def _filters(args: dict[str, Any]) -> Filters:
    return Filters.parse(None, None, args.get("date_from"), args.get("date_to"), args.get("filters") or {})


async def run_tool(ctx: DashboardContext, state: ToolState, name: str, raw_args: str) -> str:
    """Execute one tool call; errors come back as text so the model can correct itself."""
    try:
        args = json.loads(raw_args or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        return f"Error: invalid arguments ({exc})."
    state.trace.append({"tool": name, "args": args})
    try:
        if name == "query_data":
            return await _query_data(ctx, args)
        if name == "list_dimension_values":
            return await _dimension_values(ctx, args)
        if name == "get_card":
            return await _get_card(ctx, state, args)
        if name == "suggest_filter":
            return _suggest_filter(ctx, state, args)
        return f"Error: unknown tool {name}."
    except (ValidationError, *USER_ERRORS) as exc:
        return f"Error: {str(exc).splitlines()[0]}"


async def _query_data(ctx: DashboardContext, args: dict[str, Any]) -> str:
    source = ctx.sources.get(args.get("source", ""))
    if source is None:
        return f"Error: unknown source. Available: {', '.join(ctx.sources)}."
    dims = [{"name": d, **({"grain": args["time_grain"]} if args.get("time_grain") and i == 0 else {})}
            for i, d in enumerate(args.get("dimensions") or [])]
    query = SemanticQuery(dataset=args["dataset"], measures=[{"name": m} for m in args["measures"]], dimensions=dims,
                          order=args.get("order"), limit=min(args.get("limit") or MAX_QUERY_ROWS, MAX_QUERY_ROWS))
    rows, meta = await run_query(query, source.spec, _filters(args), source.version_id)
    return json.dumps({"rows": rows[:MAX_QUERY_ROWS], "filters_not_applicable": meta["ignored"]}, default=str)


async def _dimension_values(ctx: DashboardContext, args: dict[str, Any]) -> str:
    source = ctx.sources.get(args.get("source", ""))
    if source is None:
        return f"Error: unknown source. Available: {', '.join(ctx.sources)}."
    values = await dimension_values(source.spec, source.version_id, args["dimension"], Filters())
    if args.get("search"):
        values = [v for v in values if args["search"].lower() in v.lower()]
    return json.dumps({"values": values[:100], "truncated": len(values) > 100})


async def _get_card(ctx: DashboardContext, state: ToolState, args: dict[str, Any]) -> str:
    card = ctx.card(args.get("item_id", ""))
    if card is None or card.job is None:
        return "Error: unknown item_id."
    job = card.job
    result = await get_result(make_job(job.card_version_id, job.card_spec, job.source_version_id, job.source_spec, _filters(args)))
    if card.item_id not in state.cited_items:
        state.cited_items.append(card.item_id)
    return json.dumps({"name": card.name, "rows": result.rows[:MAX_QUERY_ROWS],
                       **{k: result.meta[k] for k in ("deltaPct", "deltaAbs", "prevValue", "ignored") if k in result.meta}},
                      default=str)


def _suggest_filter(ctx: DashboardContext, state: ToolState, args: dict[str, Any]) -> str:
    defs = {f["id"]: f for f in ctx.filter_defs if f["kind"] != "period"}
    if args.get("filter_id") not in defs:
        return f"Error: unknown filter. Dashboard filters: {', '.join(defs) or 'none'}."
    f = defs[args["filter_id"]]
    values = [str(v) for v in args["values"]][: (1 if f["kind"] == "select" else 20)]
    state.actions.append({"label": str(args["label"])[:60], "filter_id": f["id"], "values": values})
    return "Suggestion shown to the user as a button."
