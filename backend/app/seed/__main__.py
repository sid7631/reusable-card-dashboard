"""Seed the demo warehouse and starter content.

    uv run python -m app.seed            # idempotent: only fills what's empty
    uv run python -m app.seed --reset    # rebuild warehouse rows and starter assets
"""

import asyncio
import math
import sys
from datetime import date, timedelta

import asyncpg
from sqlalchemy import delete, select, text

from app.core.config import get_settings
from app.core.db import SessionLocal, engine
from app.governance.service import create_asset
from app.models import Asset, AssetVersion, User

# ---------------------------------------------------------------- warehouse data
SEGMENTS = {"USCS": ["Consumer", "SBS"], "GCS": ["SBS", "MM", "G&L"], "ICS": ["Consumer", "SBS", "Corporate"]}

# (name, industry, sub_industry, weight, locked_country?)
MERCHANTS = [
    ("Amazon", "G&S", "Online-Retail", 10), ("Walmart", "G&S", "Retail-Shops", 8, "US"),
    ("Stripe", "B2B", "Tech Services", 6), ("Apple", "G&S", "Retail-Shops", 5),
    ("Delta Air Lines", "T&E", "Airline", 5, "US"), ("Marriott", "T&E", "Lodging", 4),
    ("Uber", "T&E", "Ground Transport", 4), ("Costco", "G&S", "Grocery", 4, "US"),
    ("British Airways", "T&E", "Airline", 3, "UK"), ("Tesco", "G&S", "Grocery", 3, "UK"),
    ("Salesforce", "B2B", "Tech Services", 3), ("FedEx", "B2B", "Logistics", 3),
    ("Staples", "B2B", "Office Supplies", 2), ("Rakuten", "G&S", "Online-Retail", 2, "Japan"),
    ("ANA", "T&E", "Airline", 2, "Japan"),
]
PRODUCTS = [("Platinum", 5), ("Gold", 4), ("Green", 2), ("Business Platinum", 3), ("Corporate Card", 3)]
COUNTRIES = [("US", 50), ("UK", 15), ("Japan", 10), ("Canada", 8), ("Germany", 7), ("India", 5), ("Australia", 5)]
VINTAGES = [(2021, 2), (2022, 3), (2023, 4), (2024, 5), (2025, 7), (2026, 8)]

START, END = date(2024, 1, 1), date(2026, 6, 11)
ROWS = 60_000


def mulberry32(seed: int):
    """Bit-exact port of the JS PRNG used by the original POC, so the demo data is unchanged."""
    a = seed & 0xFFFFFFFF
    mask = 0xFFFFFFFF

    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & mask
        t = ((a ^ (a >> 15)) * (1 | a)) & mask
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & mask)) & mask) ^ t
        return ((t ^ (t >> 14)) & mask) / 4294967296

    return rng


def weighted_pick(rng, entries):
    weight = lambda e: e[-2] if isinstance(e[-1], str) else e[-1]  # noqa: E731
    r = rng() * sum(weight(e) for e in entries)
    for e in entries:
        r -= weight(e)
        if r <= 0:
            return e
    return entries[-1]


def generate_transactions():
    rng = mulberry32(20260611)
    total_days = (END - START).days
    segments = list(SEGMENTS)
    for _ in range(ROWS):
        day = START + timedelta(days=math.floor(rng() * total_days))
        segment = segments[math.floor(rng() * len(segments))]
        subs = SEGMENTS[segment]
        sub_segment = subs[math.floor(rng() * len(subs))]
        m = weighted_pick(rng, MERCHANTS)
        country = m[4] if len(m) > 4 else weighted_pick(rng, COUNTRIES)[0]
        product = weighted_pick(rng, PRODUCTS)[0]
        vintage = weighted_pick(rng, VINTAGES)[0]
        growth = 1.35 if day.year == 2026 else 1.15 if day.year == 2025 else 1.0
        amount = math.floor((500 + rng() * rng() * 95000) * growth * 100 + 0.5) / 100  # JS Math.round
        yield (day, segment, sub_segment, m[1], m[2], product, m[0], country, vintage, amount)


async def seed_warehouse(reset: bool) -> None:
    conn = await asyncpg.connect(get_settings().warehouse_admin_url)
    try:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id BIGSERIAL PRIMARY KEY,
                txn_date DATE NOT NULL,
                segment TEXT NOT NULL,
                sub_segment TEXT NOT NULL,
                industry TEXT NOT NULL,
                sub_industry TEXT NOT NULL,
                product TEXT NOT NULL,
                merchant TEXT NOT NULL,
                country TEXT NOT NULL,
                vintage INTEGER NOT NULL,
                amount NUMERIC(12, 2) NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions (txn_date);
            CREATE INDEX IF NOT EXISTS idx_txn_segment ON transactions (segment, sub_segment);
            GRANT SELECT ON transactions TO warehouse_reader;
        """)
        if reset:
            await conn.execute("TRUNCATE transactions RESTART IDENTITY")
        if await conn.fetchval("SELECT COUNT(*) FROM transactions") == 0:
            await conn.copy_records_to_table(
                "transactions", records=list(generate_transactions()),
                columns=["txn_date", "segment", "sub_segment", "industry", "sub_industry", "product",
                         "merchant", "country", "vintage", "amount"],
            )
            await conn.execute("ANALYZE transactions")
            print(f"Warehouse: loaded {ROWS:,} transactions.")
        else:
            print("Warehouse: already populated.")
    finally:
        await conn.close()


# ---------------------------------------------------------------- starter assets
def grouped(dimension_expr: str, limit: int | None = None) -> str:
    return (f"SELECT {dimension_expr} AS label, SUM(amount) AS value\nFROM transactions\n"
            f"WHERE 1=1 {{{{filters}}}}\nGROUP BY label\nORDER BY value DESC" + (f"\nLIMIT {limit}" if limit else ""))


def kpi(segment: str | None = None) -> str:
    where = f" AND segment = '{segment}'" if segment else ""
    return f"SELECT SUM(amount) AS value FROM transactions WHERE 1=1{where} {{{{filters}}}}"


SUM_AMOUNT = {"metric": "amount", "agg": "SUM"}

CARDS = [
    ("Total AXP Spend", "Enterprise-wide charge volume for the selected period.", "kpi", "builder", kpi(), SUM_AMOUNT),
    ("USCS Spend", "US Consumer Services charge volume.", "kpi", "builder", kpi("USCS"),
     {**SUM_AMOUNT, "filters": [{"field": "segment", "value": "USCS"}]}),
    ("GCS Spend", "Global Commercial Services charge volume.", "kpi", "builder", kpi("GCS"),
     {**SUM_AMOUNT, "filters": [{"field": "segment", "value": "GCS"}]}),
    ("ICS Spend", "International Card Services charge volume.", "kpi", "builder", kpi("ICS"),
     {**SUM_AMOUNT, "filters": [{"field": "segment", "value": "ICS"}]}),
    ("Industry Spend", "Charge volume by industry and sub-industry, with YoY deltas.", "barlist", "builder",
     "SELECT industry AS label, sub_industry AS sublabel, SUM(amount) AS value\nFROM transactions\n"
     "WHERE 1=1 {{filters}}\nGROUP BY label, sublabel\nORDER BY value DESC\nLIMIT 8",
     {**SUM_AMOUNT, "dimension": "industry", "dimension2": "sub_industry", "limit": 8,
      "controls": {"segment": True, "period": True}}),
    ("Product Spend", "Charge volume by card product, with YoY deltas.", "barlist", "builder", grouped("product"),
     {**SUM_AMOUNT, "dimension": "product", "controls": {"segment": True}}),
    ("Spend by Vintage", "Charge volume by card-member acquisition cohort.", "barlist", "builder",
     grouped("'Vintage ' || vintage"), {**SUM_AMOUNT, "dimension": "vintage", "controls": {"segment": True}}),
    ("Merchant Geography", "Charge volume by merchant country, with YoY deltas.", "barlist", "builder",
     grouped("country", 7), {**SUM_AMOUNT, "dimension": "country", "limit": 7, "controls": {"segment": True}}),
    ("Top Merchants by Charge Volume", "Top five merchants ranked by total spend.", "barlist", "builder",
     grouped("merchant", 5),
     {**SUM_AMOUNT, "dimension": "merchant", "limit": 5, "rank": True, "controls": {"segment": True}}),
    ("Spend Share by Segment", "How charge volume splits across business segments.", "donut", "builder",
     grouped("segment"), {**SUM_AMOUNT, "dimension": "segment"}),
    ("Monthly Spend Trend by Product", "Monthly charge volume for the three flagship consumer products.", "line", "sql",
     "SELECT to_char(txn_date, 'YYYY-MM') AS label,\n"
     "  SUM(CASE WHEN product = 'Platinum' THEN amount ELSE 0 END) AS \"Platinum\",\n"
     "  SUM(CASE WHEN product = 'Gold' THEN amount ELSE 0 END) AS \"Gold\",\n"
     "  SUM(CASE WHEN product = 'Green' THEN amount ELSE 0 END) AS \"Green\"\n"
     "FROM transactions\nWHERE 1=1 {{filters}}\nGROUP BY label\nORDER BY label",
     {**SUM_AMOUNT, "dimension": "txn_date", "timeGrain": "month"}),
    ("Daily Spend — Rolling 90 Days", "Daily charge volume over the trailing 90-day window.", "area", "sql",
     "SELECT txn_date AS label, SUM(amount) AS value\nFROM transactions\n"
     "WHERE txn_date >= DATE '2026-06-11' - INTERVAL '90 days' {{filters}}\nGROUP BY label\nORDER BY label",
     {**SUM_AMOUNT, "dimension": "txn_date", "timeGrain": "day",
      "controls": {"segment": True, "period": True, "periodOptions": ["month", "quarter", "ytd"]}}),
]

LAYOUT = [
    ("Total AXP Spend", 0, 0, 3, 2), ("USCS Spend", 3, 0, 3, 2), ("GCS Spend", 6, 0, 3, 2), ("ICS Spend", 9, 0, 3, 2),
    ("Industry Spend", 0, 2, 4, 5), ("Product Spend", 4, 2, 4, 5), ("Spend by Vintage", 8, 2, 4, 5),
    ("Merchant Geography", 0, 7, 4, 5), ("Top Merchants by Charge Volume", 4, 7, 4, 5),
    ("Spend Share by Segment", 8, 7, 4, 5),
    ("Monthly Spend Trend by Product", 0, 12, 6, 4), ("Daily Spend — Rolling 90 Days", 6, 12, 6, 4),
]

DEMO_SOURCE = {
    "type": "postgres",
    "connection": {"host": "env:DEMO_WAREHOUSE_HOST", "port": "env:DEMO_WAREHOUSE_PORT", "database": "demo_warehouse",
                   "user": "warehouse_reader", "secret_ref": "env:DEMO_WAREHOUSE_PASSWORD"},
    "execution": {"max_concurrency": 10, "timeout_s": 30, "cache_ttl_s": 900},
    "model": {"datasets": [{
        "name": "transactions",
        "label": "Charge transactions",
        "description": "One row per card charge: when, which business segment, merchant, product and amount.",
        "time_dimension": "txn_date",
        "dimensions": [
            {"name": "txn_date", "column": "txn_date", "type": "date", "label": "Transaction date"},
            {"name": "segment", "column": "segment", "label": "Segment", "description": "Business segment: USCS, GCS or ICS"},
            {"name": "sub_segment", "column": "sub_segment", "label": "Sub-segment"},
            {"name": "industry", "column": "industry", "label": "Industry", "description": "Merchant industry (T&E, G&S, B2B)"},
            {"name": "sub_industry", "column": "sub_industry", "label": "Sub-industry"},
            {"name": "product", "column": "product", "label": "Card product"},
            {"name": "merchant", "column": "merchant", "label": "Merchant"},
            {"name": "country", "column": "country", "label": "Merchant country"},
            {"name": "vintage", "column": "vintage", "type": "number", "label": "Vintage",
             "description": "Year the card member was acquired"},
        ],
        "measures": [
            {"name": "total_spend", "expr": "SUM(amount)", "label": "Total spend", "format": "currency",
             "description": "Charge volume in USD"},
            {"name": "txn_count", "expr": "COUNT(*)", "label": "Transactions"},
            {"name": "avg_ticket", "expr": "AVG(amount)", "label": "Average ticket", "format": "currency"},
        ],
    }]},
}


async def seed_assets(reset: bool) -> None:
    async with SessionLocal() as session:
        if reset:
            # Versions are immutable by design; a full reset truncates instead of deleting row by row
            await session.execute(text(
                "TRUNCATE audit_events, change_request_items, change_requests, asset_shares, "
                "asset_dependencies, asset_versions, assets RESTART IDENTITY CASCADE"))
            await session.execute(delete(User).where(User.sub == "system"))
            await session.commit()
        if await session.scalar(select(Asset.id).limit(1)) is not None:
            print("Assets: already seeded.")
            return

        system = User(sub="system", email="system@spendboard.local", name="SpendBoard", role="admin")
        session.add(system)
        await session.flush()

        source, source_v = await create_asset(
            session, system, "data_source", name="Demo Warehouse",
            description="Card charge transactions (Postgres, 60k rows).", spec=DEMO_SOURCE, scope="global")

        card_refs = {}
        for name, description, chart_type, via, sql, config in CARDS:
            card, version = await create_asset(session, system, "card", name=name, description=description, scope="global",
                                               spec={"chart_type": chart_type, "created_via": via, "config": config,
                                                     "query": {"mode": "sql", "sql": sql},
                                                     "data_source": {"asset_id": source.id, "version_id": source_v.id}})
            card_refs[name] = {"asset_id": card.id, "version_id": version.id}

        await create_asset(
            session, system, "dashboard", name="Enterprise Spend Overview",
            description="Performance summary — spend by segment, industry, product, vintage and geography.",
            scope="global",
            spec={"items": [{"card": card_refs[n], "x": x, "y": y, "w": w, "h": h} for n, x, y, w, h in LAYOUT],
                  "filters": DEMO_FILTERS})
        await session.commit()
        print(f"Assets: seeded 1 data source, {len(CARDS)} cards, 1 dashboard (global v1).")


# Stand-in for directory sync (SCIM) from the IdP, so people can be found for sharing before their
# first sign-in. Mirrors the demo accounts in apps/web/server/index.mjs.
DIRECTORY = [
    ("u-avery", "Avery Admin", "avery@spendboard.local", "admin"),
    ("u-riley", "Riley Analyst", "riley@spendboard.local", "user"),
    ("u-jordan", "Jordan Analyst", "jordan@spendboard.local", "user"),
]


async def sync_directory() -> None:
    async with SessionLocal() as session:
        existing = set(await session.scalars(select(User.sub)))
        session.add_all(User(sub=sub, name=name, email=email, role=role)
                        for sub, name, email, role in DIRECTORY if sub not in existing)
        await session.commit()


DEMO_FILTERS = [
    {"id": "segment", "kind": "select", "dimension": "segment", "label": "Segment"},
    {"id": "sub_segment", "kind": "multi", "dimension": "sub_segment", "label": "Sub-segment", "parent": "segment"},
    {"id": "period", "kind": "period", "label": "Period", "default": ["ytd"]},
]


async def upgrade_demo() -> None:
    """Bring databases seeded before phase 4 up to date through normal versioning (never edits history):
    demo source v2 with the full semantic model, global cards re-pinned to it, and filters on the
    Enterprise Spend Overview dashboard."""
    from app.governance.service import save_version
    from app.governance.specs import DataSourceSpec

    async with SessionLocal() as session:
        system = await session.scalar(select(User).where(User.sub == "system"))
        source = await session.scalar(select(Asset).where(Asset.kind == "data_source", Asset.scope == "global",
                                                          Asset.name == "Demo Warehouse"))
        if system is None or source is None:
            return
        head = await session.get(AssetVersion, source.head_version_id)
        changed = False
        if DataSourceSpec.model_validate(head.spec).model.datasets[0].time_dimension is None:
            await save_version(session, system, source, name=head.name, description=head.description,
                               spec={**DEMO_SOURCE}, change_note="Semantic model: labels, measures, time dimension")
            changed = True

        cards = await session.scalars(select(Asset).where(Asset.kind == "card", Asset.scope == "global",
                                                          Asset.archived_at.is_(None)))
        for card in cards:
            v = await session.get(AssetVersion, card.head_version_id)
            ref = v.spec["data_source"]
            if ref["asset_id"] == source.id and ref["version_id"] != source.head_version_id:
                await save_version(session, system, card, name=v.name, description=v.description,
                                   spec={**v.spec, "data_source": {"asset_id": source.id, "version_id": source.head_version_id}},
                                   change_note="Use Demo Warehouse semantic model")
                changed = True

        dash = await session.scalar(select(Asset).where(Asset.kind == "dashboard", Asset.scope == "global",
                                                        Asset.name == "Enterprise Spend Overview"))
        if dash is not None:
            dv = await session.get(AssetVersion, dash.head_version_id)
            heads = {a.id: a.head_version_id for a in await session.scalars(
                select(Asset).where(Asset.id.in_([i["card"]["asset_id"] for i in dv.spec["items"]])))}
            items = [{**i, "card": {**i["card"], "version_id": heads.get(i["card"]["asset_id"], i["card"]["version_id"])}}
                     for i in dv.spec["items"]]
            if not dv.spec.get("filters") or items != dv.spec["items"]:
                await save_version(session, system, dash, name=dv.name, description=dv.description,
                                   spec={**dv.spec, "items": items, "filters": dv.spec.get("filters") or DEMO_FILTERS},
                                   change_note="Hierarchical filters; cards on the semantic model")
                changed = True
        await session.commit()
        print("Demo content: upgraded for the semantic layer." if changed else "Demo content: up to date.")


BQ_PROJECT, BQ_DATASET = "spendboard-demo", "analytics"


def _load_bigquery_emulator(host: str) -> int:
    """Load the demo transactions into the emulator (in-memory, so this repeats after a restart)."""
    import time

    from google.api_core.client_options import ClientOptions
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import bigquery

    client = bigquery.Client(project=BQ_PROJECT, credentials=AnonymousCredentials(),
                             client_options=ClientOptions(api_endpoint=host))
    for _ in range(60):  # the emulator may still be starting
        try:
            client.get_dataset(f"{BQ_PROJECT}.{BQ_DATASET}")
            break
        except Exception:  # noqa: BLE001 — connection refused / not ready yet
            time.sleep(1)
    else:
        raise RuntimeError(f"BigQuery emulator at {host} did not become ready.")
    table_id = f"{BQ_PROJECT}.{BQ_DATASET}.transactions"
    try:
        if (client.get_table(table_id).num_rows or 0) > 0:
            return 0
    except Exception:  # noqa: BLE001 — table not created yet
        pass
    schema = [bigquery.SchemaField(n, t) for n, t in [
        ("txn_date", "DATE"), ("segment", "STRING"), ("sub_segment", "STRING"), ("industry", "STRING"),
        ("sub_industry", "STRING"), ("product", "STRING"), ("merchant", "STRING"), ("country", "STRING"),
        ("vintage", "INT64"), ("amount", "NUMERIC")]]
    client.delete_table(table_id, not_found_ok=True)
    client.create_table(bigquery.Table(table_id, schema=schema))
    names = [f.name for f in schema]
    rows = [{k: (v.isoformat() if isinstance(v, date) else str(v) if k == "amount" else v) for k, v in zip(names, r, strict=True)}
            for r in generate_transactions()]
    for i in range(0, len(rows), 10_000):
        errors = client.insert_rows_json(table_id, rows[i:i + 10_000])
        if errors:
            raise RuntimeError(f"BigQuery emulator rejected rows: {errors[:1]}")
    return len(rows)


async def seed_bigquery_demo() -> None:
    """Demo stack only: BigQuery data in the emulator, plus a global source, cards and dashboard on it."""
    host = get_settings().bigquery_emulator_host
    if not host:
        return
    loaded = await asyncio.to_thread(_load_bigquery_emulator, host)
    print(f"BigQuery emulator: loaded {loaded:,} transactions." if loaded else "BigQuery emulator: already loaded.")

    async with SessionLocal() as session:
        if await session.scalar(select(Asset.id).where(Asset.kind == "data_source", Asset.scope == "global",
                                                       Asset.name == "Demo Warehouse (BigQuery)")):
            return
        system = await session.scalar(select(User).where(User.sub == "system"))
        if system is None:
            return
        spec = {**DEMO_SOURCE, "type": "bigquery", "connection": None,
                "bigquery": {"project": BQ_PROJECT, "dataset": BQ_DATASET, "auth": "adc"}}
        source, source_v = await create_asset(session, system, "data_source", name="Demo Warehouse (BigQuery)",
                                              description="The demo transactions in BigQuery (local emulator).",
                                              spec=spec, scope="global")
        ref = {"asset_id": source.id, "version_id": source_v.id}

        def semantic(chart, dims, **extra):
            return {"chart_type": chart, "data_source": ref, "created_via": "builder", "config": extra.pop("config", {}),
                    "query": {"mode": "semantic", "dataset": "transactions", "measures": [{"name": "total_spend"}],
                              "dimensions": dims, **extra}}

        cards = [
            ("Total spend (BigQuery)", "Charge volume for the selected period.", semantic("kpi", []), (0, 0, 4, 2)),
            ("Spend by segment (BigQuery)", "Charge volume by business segment.",
             semantic("donut", [{"name": "segment"}], config={"dimension": "segment", "measure": "total_spend"}), (4, 0, 4, 5)),
            ("Monthly spend (BigQuery)", "Charge volume by month.",
             semantic("line", [{"name": "txn_date", "grain": "month"}], order="label_asc",
                      config={"dimension": "txn_date", "timeGrain": "month", "measure": "total_spend"}), (8, 0, 4, 5)),
            ("Top merchants (BigQuery)", "Five merchants with the most spend.",
             semantic("barlist", [{"name": "merchant"}], limit=5,
                      config={"dimension": "merchant", "measure": "total_spend", "limit": 5, "rank": True}), (0, 2, 4, 5)),
        ]
        items = []
        for name, description, card_spec, (x, y, w, h) in cards:
            card, version = await create_asset(session, system, "card", name=name, description=description,
                                               spec=card_spec, scope="global")
            items.append({"card": {"asset_id": card.id, "version_id": version.id}, "x": x, "y": y, "w": w, "h": h})
        await create_asset(session, system, "dashboard", name="BigQuery Demo",
                           description="The same demo data, queried in BigQuery through the dialect-aware SQL layer.",
                           spec={"items": items, "filters": DEMO_FILTERS}, scope="global")
        await session.commit()
        print("BigQuery demo: created source, 4 cards and a dashboard.")


async def main(reset: bool) -> None:
    await seed_warehouse(reset)
    await seed_assets(reset)
    await sync_directory()
    await upgrade_demo()
    await seed_bigquery_demo()
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main(reset="--reset" in sys.argv))
