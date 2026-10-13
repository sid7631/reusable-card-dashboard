"""Demo content beyond the starter library: a CSV upload and a REST API as global sources (with example
cards and dashboards), and a walkthrough of governance by the four demo accounts (two admins, two
analysts) — private copies, change requests in every state with conversations, sharing, and
dashboards with card updates waiting.

Everything goes through the normal governance functions, so versions, audit events and request
history look exactly as if the people had clicked through the app. Runs once, on a fresh database.
"""

import asyncio
import csv
import hashlib
import io
import math
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors import duck, files
from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.storage import get_storage, scratch_path
from app.governance import requests as cr
from app.governance.service import create_asset, save_version, set_share
from app.models import Asset, AssetVersion, ChangeRequest, ChangeRequestItem, ChangeRequestRead, FileObject, User

PERIOD_ONLY = [{"id": "period", "kind": "period", "label": "Period", "default": ["ytd"]}]
SEGMENT_FILTERS = [
    {"id": "segment", "kind": "select", "dimension": "segment", "label": "Segment"},
    {"id": "sub_segment", "kind": "multi", "dimension": "sub_segment", "label": "Sub-segment", "parent": "segment"},
    {"id": "period", "kind": "period", "label": "Period", "default": ["ytd"]},
]


# ---------------------------------------------------------------- CSV upload: budget plan
BUDGET_FILE = "budget_plan.csv"
BUDGET_TABLE = "budget_plan"


def budget_csv() -> bytes:
    """Monthly budget and forecast per sub-segment, 2024–2026, on the scale of the demo transactions."""
    from app.seed.__main__ import SEGMENTS, mulberry32

    rng = mulberry32(20261001)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["month", "segment", "sub_segment", "budget_usd", "forecast_usd"])
    for year in (2024, 2025, 2026):
        growth = {2024: 1.0, 2025: 1.15, 2026: 1.35}[year]
        for month in range(1, 13):
            season = 1 + 0.12 * math.sin((month - 3) / 12 * 2 * math.pi)
            for segment, subs in SEGMENTS.items():
                for sub in subs:
                    budget = round(18_000_000 / len(subs) * growth * season * (0.9 + rng() * 0.2), -3)
                    forecast = round(budget * (0.88 + rng() * 0.22), -3)
                    w.writerow([date(year, month, 1).isoformat(), segment, sub, budget, forecast])
    return out.getvalue().encode()


BUDGET_MODEL = {"datasets": [{
    "name": BUDGET_TABLE, "label": "Budget plan",
    "description": "Finance's monthly budget and latest forecast per business sub-segment (uploaded CSV).",
    "time_dimension": "month",
    "dimensions": [
        {"name": "month", "column": "month", "type": "date", "label": "Month"},
        {"name": "segment", "column": "segment", "label": "Segment"},
        {"name": "sub_segment", "column": "sub_segment", "label": "Sub-segment"},
    ],
    "measures": [
        {"name": "total_budget", "expr": "SUM(budget_usd)", "label": "Budget", "format": "currency"},
        {"name": "total_forecast", "expr": "SUM(forecast_usd)", "label": "Forecast", "format": "currency"},
        {"name": "forecast_variance", "expr": "SUM(forecast_usd - budget_usd)", "label": "Forecast vs budget",
         "format": "currency", "description": "Positive = forecast above budget"},
    ],
}]}


async def ingest_file(session: AsyncSession, owner: User, filename: str, data: bytes) -> FileObject:
    """What POST /api/files does: keep the upload and its DuckDB database in storage."""
    record = FileObject(uploaded_by=owner.id, filename=filename, format=files.detect_format(filename), size=len(data),
                        checksum=hashlib.sha256(data).hexdigest(), storage_key="", db_key="")
    session.add(record)
    await session.flush()
    raw_path, db_path = scratch_path(".csv"), scratch_path(".duckdb")
    try:
        raw_path.write_bytes(data)
        record.tables = await asyncio.to_thread(files.ingest, raw_path, record.format, db_path,
                                                duck.safe_table_name(filename.rsplit(".", 1)[0], "upload"))
        record.storage_key, record.db_key = f"uploads/{record.id}.csv", f"files/{record.id}.duckdb"
        store = get_storage()
        await asyncio.to_thread(store.put_file, record.storage_key, raw_path)
        await asyncio.to_thread(store.put_file, record.db_key, db_path)
    finally:
        raw_path.unlink(missing_ok=True)
        db_path.unlink(missing_ok=True)
    return record


# ---------------------------------------------------------------- REST API: merchant partner program
PARTNER_MODEL = {"datasets": [{
    "name": "partners", "label": "Merchant partners",
    "description": "One row per merchant in the partner program (REST API, refreshed every 15 minutes).",
    "dimensions": [
        {"name": "merchant", "column": "merchant", "label": "Merchant"},
        {"name": "industry", "column": "industry", "label": "Industry"},
        {"name": "sub_industry", "column": "sub_industry", "label": "Sub-industry"},
        {"name": "tier", "column": "program_tier", "label": "Partner tier"},
        {"name": "region", "column": "program_region", "label": "Region"},
        {"name": "status", "column": "program_status", "label": "Program status"},
    ],
    "measures": [
        {"name": "partners", "expr": "COUNT(*)", "label": "Partners"},
        {"name": "enrolled", "expr": "SUM(enrolled_cardmembers)", "label": "Enrolled card members"},
        {"name": "rewards_cost", "expr": "SUM(rewards_cost_usd)", "label": "Rewards cost", "format": "currency"},
        {"name": "active_offers", "expr": "SUM(active_offers)", "label": "Active offers"},
        {"name": "avg_satisfaction", "expr": "AVG(satisfaction)", "label": "Avg. satisfaction"},
    ],
}]}


def _measure_formats() -> dict[str, str]:
    from app.seed.__main__ import DEMO_SOURCE
    models = (BUDGET_MODEL, PARTNER_MODEL, DEMO_SOURCE["model"])
    return {m["name"]: m.get("format", "number") for model in models for d in model["datasets"] for m in d["measures"]}


def semantic(ref: dict[str, int], dataset: str, chart: str, measure: str, dims: list[dict[str, Any]] | None = None,
             config: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    # Like the studio: the card remembers its measure's format, so a count KPI doesn't read as money
    return {"chart_type": chart, "data_source": ref, "created_via": "builder",
            "config": {"measure": measure, "format": _measure_formats().get(measure, "number"),
                       **({"dimension": dims[0]["name"]} if dims else {}), **(config or {})},
            "query": {"mode": "semantic", "dataset": dataset, "measures": [{"name": measure}],
                      "dimensions": dims or [], **extra}}


def sql_card(ref: dict[str, int], chart: str, sql: str, config: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"chart_type": chart, "data_source": ref, "created_via": "sql", "config": config or {},
            "query": {"mode": "sql", "sql": sql}}


async def _global_with_cards(session: AsyncSession, system: User, source_name: str, description: str,
                             source_spec: dict[str, Any], cards: list[tuple], dashboard: tuple[str, str, list]) -> None:
    source, source_v = await create_asset(session, system, "data_source", name=source_name, description=description,
                                          spec=source_spec, scope="global")
    ref = {"asset_id": source.id, "version_id": source_v.id}
    items = []
    for name, card_description, build, layout in cards:
        card, version = await create_asset(session, system, "card", name=name, description=card_description,
                                           spec=build(ref), scope="global")
        items.append({"card": {"asset_id": card.id, "version_id": version.id},
                      **dict(zip(("x", "y", "w", "h"), layout, strict=True))})
    dash_name, dash_description, filters = dashboard
    await create_asset(session, system, "dashboard", name=dash_name, description=dash_description,
                       spec={"items": items, "filters": filters}, scope="global")


async def seed_more_sources() -> None:
    """Global CSV and REST sources, each with example cards and a dashboard."""
    async with SessionLocal() as session:
        system = await session.scalar(select(User).where(User.sub == "system"))
        if system is None:
            return
        existing = set(await session.scalars(select(Asset.name).where(Asset.kind == "data_source", Asset.scope == "global")))

        if "Budget Plan (CSV)" not in existing:
            upload = await ingest_file(session, system, BUDGET_FILE, budget_csv())
            await _global_with_cards(
                session, system, "Budget Plan (CSV)", "Finance's 2024–2026 budget and forecast — an uploaded CSV file.",
                {"type": "file", "file": {"file_id": upload.id}, "execution": {"cache_ttl_s": 900}, "model": BUDGET_MODEL},
                [
                    ("Total Budget", "Budget for the selected period.",
                     lambda r: semantic(r, BUDGET_TABLE, "kpi", "total_budget"), (0, 0, 4, 2)),
                    ("Forecast vs Budget", "Latest forecast minus budget — positive means ahead of plan.",
                     lambda r: semantic(r, BUDGET_TABLE, "kpi", "forecast_variance"), (4, 0, 4, 2)),
                    ("Total Forecast", "Latest forecast for the selected period.",
                     lambda r: semantic(r, BUDGET_TABLE, "kpi", "total_forecast"), (8, 0, 4, 2)),
                    ("Monthly Budget vs Forecast", "Budget and forecast by month (SQL on the uploaded file).",
                     lambda r: sql_card(r, "line",
                                        "SELECT strftime(month, '%Y-%m') AS label,\n  SUM(budget_usd) AS \"Budget\",\n"
                                        "  SUM(forecast_usd) AS \"Forecast\"\nFROM budget_plan\nWHERE 1=1 {{filters}}\n"
                                        "GROUP BY label\nORDER BY label",
                                        {"dimension": "month", "timeGrain": "month"}), (0, 2, 8, 5)),
                    ("Budget by Segment", "How the budget splits across business segments.",
                     lambda r: semantic(r, BUDGET_TABLE, "donut", "total_budget", [{"name": "segment"}]), (8, 2, 4, 5)),
                    ("Budget by Sub-segment", "Budget per sub-segment, largest first.",
                     lambda r: semantic(r, BUDGET_TABLE, "barlist", "total_budget", [{"name": "sub_segment"}],
                                        {"controls": {"filters": ["segment"]}}), (0, 7, 6, 5)),
                ],
                ("Budget Planning", "Plan vs forecast from Finance's uploaded budget file.", SEGMENT_FILTERS))
            print("Demo: created the CSV budget source, 6 example cards and a dashboard.")

        if "Merchant Partner Program (REST)" not in existing:
            url = f"{get_settings().demo_api_base_url.rstrip('/')}/demo/merchant-partners"
            await _global_with_cards(
                session, system, "Merchant Partner Program (REST)",
                "Partner merchants, offers and enrolments from the partner API (REST, JSON).",
                {"type": "rest", "rest": {"url": url, "records_path": "data.partners", "table": "partners"},
                 "execution": {"cache_ttl_s": 900}, "model": PARTNER_MODEL},
                [
                    ("Partner Merchants", "Merchants in the partner program.",
                     lambda r: semantic(r, "partners", "kpi", "partners"), (0, 0, 3, 2)),
                    ("Enrolled Card Members", "Card members enrolled in partner offers.",
                     lambda r: semantic(r, "partners", "kpi", "enrolled"), (3, 0, 3, 2)),
                    ("Partner Rewards Cost", "What partner rewards cost us.",
                     lambda r: semantic(r, "partners", "kpi", "rewards_cost"), (6, 0, 3, 2)),
                    ("Active Partner Offers", "Offers currently live across partners.",
                     lambda r: semantic(r, "partners", "kpi", "active_offers"), (9, 0, 3, 2)),
                    ("Partners by Tier", "Program mix by partner tier.",
                     lambda r: semantic(r, "partners", "donut", "partners", [{"name": "tier"}]), (0, 2, 4, 5)),
                    ("Enrolment by Merchant", "Top partner merchants by enrolled card members.",
                     lambda r: semantic(r, "partners", "barlist", "enrolled", [{"name": "merchant"}], {"limit": 8, "rank": True},
                                        limit=8), (4, 2, 4, 5)),
                    ("Rewards Cost by Industry", "Partner rewards cost per merchant industry.",
                     lambda r: semantic(r, "partners", "bar", "rewards_cost", [{"name": "industry"}]), (8, 2, 4, 5)),
                ],
                ("Merchant Partners", "The partner program at a glance — data from the partner REST API.",
                 [{"id": "tier", "kind": "select", "dimension": "tier", "label": "Partner tier"},
                  {"id": "region", "kind": "multi", "dimension": "region", "label": "Region"}]))
            print("Demo: created the REST partner source, 7 example cards and a dashboard.")
        await session.commit()


# ---------------------------------------------------------------- governance walkthrough
async def _by_name(session: AsyncSession, kind: str, name: str, scope: str = "global") -> Asset:
    asset = await session.scalar(select(Asset).where(Asset.kind == kind, Asset.scope == scope, Asset.name == name,
                                                     Asset.archived_at.is_(None)))
    if asset is None:
        raise LookupError(f"Demo story needs the {scope} {kind} “{name}”.")
    return asset


async def _revise(session: AsyncSession, user: User, asset: Asset, note: str, *, name: str | None = None,
                  description: str | None = None, sql: tuple[str, str] | None = None, **config: Any) -> AssetVersion:
    """Save a new version of `asset` with a few changes, like an edit in the studio."""
    head = await session.get(AssetVersion, asset.head_version_id)
    spec = {**head.spec, "config": {**head.spec.get("config", {}), **config}}
    if sql is not None:
        spec["query"] = {**spec["query"], "sql": spec["query"]["sql"].replace(*sql)}
    return await save_version(session, user, asset, name=name or head.name, description=description or head.description,
                              spec=spec, change_note=note)


def _ref(asset: Asset) -> dict[str, int]:
    return {"asset_id": asset.id, "version_id": asset.head_version_id}


async def seed_demo_story() -> None:
    async with SessionLocal() as session:
        if await session.scalar(select(ChangeRequest.id).limit(1)) is not None:
            return  # already played (or real activity exists) — never add demo activity on top
        subs = ["u-avery", "u-morgan", "u-riley", "u-jordan"]
        people = {u.sub: u for u in await session.scalars(select(User).where(User.sub.in_(subs)))}
        if len(people) < len(subs):
            return
        avery, morgan, riley, jordan = (people[s] for s in subs)
        card = lambda name: _by_name(session, "card", name)  # noqa: E731

        # Avery maintains the global library directly (admins edit global assets in place)
        await _revise(session, avery, await card("Top Merchants by Charge Volume"), "Clarify ranking basis",
                      description="Top five merchants ranked by total charge volume in the selected period.")
        await _revise(session, avery, await card("Industry Spend"), "Wording",
                      description="Charge volume by merchant industry and sub-industry, with YoY deltas.")

        # Riley: a private copy of Product Spend (global vN → private N.1, N.2)
        product = await card("Product Spend")
        product_copy, _ = await cr.fork_asset(session, riley, product)
        await _revise(session, riley, product_copy, "Emerald palette, clearer description", scheme="emerald",
                      description="Charge volume by card product — consumer and commercial — with YoY deltas.")

        # Riley: a brand-new private card (0.1, 0.2 until it is published)
        demo = await _by_name(session, "data_source", "Demo Warehouse")
        ticket, _ = await create_asset(
            session, riley, "card", name="Average Ticket by Card Product",
            description="Average charge amount per card product.",
            spec=semantic(_ref(demo), "transactions", "barlist", "avg_ticket", [{"name": "product"}]))
        await _revise(session, riley, ticket, "Rank products, violet palette", rank=True, scheme="violet")

        # Riley's own dashboard, built while Product Spend was still at its current global version
        partners_tier = await card("Partners by Tier")
        riley_dash, _ = await create_asset(
            session, riley, "dashboard", name="Riley — Consumer Watch",
            description="My weekly view: headline spend, product mix, ticket size and partner coverage.",
            spec={"filters": SEGMENT_FILTERS, "items": [
                {"card": _ref(await card("Total AXP Spend")), "x": 0, "y": 0, "w": 4, "h": 2},
                {"card": _ref(await card("USCS Spend")), "x": 4, "y": 0, "w": 4, "h": 2},
                {"card": _ref(await card("ICS Spend")), "x": 8, "y": 0, "w": 4, "h": 2},
                {"card": _ref(product), "x": 0, "y": 2, "w": 4, "h": 5},
                {"card": _ref(ticket), "x": 4, "y": 2, "w": 4, "h": 5},
                {"card": _ref(await card("Spend Share by Segment")), "x": 8, "y": 2, "w": 4, "h": 5},
                {"card": _ref(partners_tier), "x": 0, "y": 7, "w": 4, "h": 5},
                {"card": _ref(await card("Top Merchants by Charge Volume")), "x": 4, "y": 7, "w": 4, "h": 5},
            ]})
        await set_share(session, riley, riley_dash, "owner", jordan.id, "edit")
        await set_share(session, riley, ticket, "owner", jordan.id, "view")

        # #1 — Riley proposes the Product Spend change; Avery approves (global → next version).
        # Riley's dashboard and the global overview now show "Update" on that card.
        req = await cr.submit(session, riley, product_copy, "owner", "Product Spend: emerald palette",
                              "Matches the consumer team's slides; description now says what's included.")
        await session.flush()
        await cr.approve(session, avery, req, "Looks good — thanks Riley.")
        seen = [(req, riley)]

        # #2 and #3 — Riley and Jordan both propose changes to Top Merchants (both in review). Each request
        # warns that approving it affects the other; the global card says 2 open requests are changing it.
        top = await card("Top Merchants by Charge Volume")
        merchants_copy, _ = await cr.fork_asset(session, riley, top)
        await _revise(session, riley, merchants_copy, "Top 10 instead of top 5", sql=("LIMIT 5", "LIMIT 10"), limit=10,
                      description="Top ten merchants ranked by total charge volume in the selected period.")
        req = await cr.submit(session, riley, merchants_copy, "owner", "Show the top 10 merchants",
                              "Five hides most of the travel merchants we review each week.")
        await session.flush()
        await cr.add_comment(session, riley, req, "Previews look right for Q2. Happy to go to 8 if 10 feels crowded.")
        top_copy_j, _ = await cr.fork_asset(session, jordan, top)
        await _revise(session, jordan, top_copy_j, "Sunset palette", scheme="sunset")
        await cr.submit(session, jordan, top_copy_j, "owner", "Top Merchants: sunset palette",
                        "Matches the finance deck. Doesn't touch the ranking.")

        # #4 — Jordan restyles Spend Share by Segment; Morgan publishes it as v5 (version override)
        share = await card("Spend Share by Segment")
        share_copy, _ = await cr.fork_asset(session, jordan, share)
        await _revise(session, jordan, share_copy, "Violet palette for the segment view", scheme="violet",
                      description="How charge volume splits across USCS, GCS and ICS.")
        req = await cr.submit(session, jordan, share_copy, "owner", "Segment share: new palette and description", "")
        await session.flush()
        [item] = await session.scalars(select(ChangeRequestItem).where(ChangeRequestItem.request_id == req.id))
        await cr.approve(session, morgan, req, "Published as v5 to line up with the Q4 metrics release.", {item.id: 5})
        seen.append((req, jordan))

        # #5 and #6 — Jordan wants 10 countries on Merchant Geography, Riley wants 8. Morgan approves Riley's
        # first, so Jordan's now conflicts with the global version. The admins talk it through with Jordan
        # and send it back with "Request changes": keep 10, resolve the conflict, send it back.
        geo = await card("Merchant Geography")
        geo_copy, _ = await cr.fork_asset(session, jordan, geo)
        await _revise(session, jordan, geo_copy, "Show 10 countries", sql=("LIMIT 7", "LIMIT 10"), limit=10)
        geo_req = await cr.submit(session, jordan, geo_copy, "owner", "Merchant Geography: 10 countries",
                                  "We added Canada and Germany to the review.")
        geo_copy_r, _ = await cr.fork_asset(session, riley, geo)
        await _revise(session, riley, geo_copy_r, "Show 8 countries", sql=("LIMIT 7", "LIMIT 8"), limit=8)
        req = await cr.submit(session, riley, geo_copy_r, "owner", "Merchant Geography: 8 countries",
                              "Seven drops Canada, which is now a top-8 market.")
        await session.flush()
        await cr.approve(session, morgan, req, "Approved — note Jordan's request #%d also changes this card." % geo_req.id)
        seen.append((req, riley))
        await cr.add_comment(session, avery, geo_req, "Why 10? Riley's change to 8 countries was just approved.")
        await cr.add_comment(session, jordan, geo_req, "We added Canada and Germany to the review — 8 cuts off Germany.")
        await cr.add_comment(session, morgan, geo_req, "10 works for me, it's still readable on the card.")
        await cr.request_changes(session, avery, geo_req,
                                 "OK, let's go with 10. Please resolve the conflict with the current global version "
                                 "(choose “Keep mine”) and send it back.")

        # #7 — Jordan's budget dashboard (with a private card) is discussed, then rejected
        budget = await _by_name(session, "data_source", "Budget Plan (CSV)")
        gcs_card, _ = await create_asset(
            session, jordan, "card", name="GCS Budget vs Forecast", description="Monthly plan vs forecast for GCS.",
            spec=sql_card(_ref(budget), "area",
                          "SELECT strftime(month, '%Y-%m') AS label,\n  SUM(budget_usd) AS \"Budget\",\n"
                          "  SUM(forecast_usd) AS \"Forecast\"\nFROM budget_plan\nWHERE segment = 'GCS' {{filters}}\n"
                          "GROUP BY label\nORDER BY label", {"dimension": "month", "timeGrain": "month", "scheme": "ocean"}))
        jordan_dash, _ = await create_asset(
            session, jordan, "dashboard", name="Jordan — Budget Review",
            description="Monthly budget review for commercial (GCS).",
            spec={"filters": PERIOD_ONLY, "items": [
                {"card": _ref(await card("Total Budget")), "x": 0, "y": 0, "w": 4, "h": 2},
                {"card": _ref(await card("Total Forecast")), "x": 4, "y": 0, "w": 4, "h": 2},
                {"card": _ref(await card("Forecast vs Budget")), "x": 8, "y": 0, "w": 4, "h": 2},
                {"card": _ref(gcs_card), "x": 0, "y": 2, "w": 8, "h": 5},
                {"card": _ref(await card("Budget by Sub-segment")), "x": 8, "y": 2, "w": 4, "h": 5},
                {"card": _ref(await card("GCS Spend")), "x": 0, "y": 7, "w": 4, "h": 2},
            ]})
        await set_share(session, jordan, jordan_dash, "owner", riley.id, "view")
        req = await cr.submit(session, jordan, jordan_dash, "owner", "Publish the GCS budget review",
                              "Finance asked for this to be in the global library.")
        await session.flush()
        await cr.add_comment(session, avery, req, "Could this use the Segment filter instead of a GCS-only card?")
        await cr.add_comment(session, jordan, req, "Finance only reviews GCS today, but I can generalise it.")
        await cr.reject(session, morgan, req, "Let's not publish a GCS-only version. Please switch the card to the "
                                              "dashboard's Segment filter, then send a new request.")
        seen.append((req, jordan))

        # Requesters have already read their older, decided requests; the open ones have news waiting
        await session.flush()
        session.add_all(ChangeRequestRead(request_id=r.id, user_id=u.id) for r, u in seen[:-1])
        await session.commit()
        print("Demo story: Avery and Morgan (admins), Riley and Jordan — 7 change requests (3 approved, 2 in review on "
              "the same card, 1 sent back with a conflict, 1 rejected), conversations, copies, drafts, shares.")
