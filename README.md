# SpendBoard — Reusable Cards & Dashboards (POC)

Build chart **cards** (widgets) bound to a data source + SQL, store them once, and reuse them
across any number of drag-and-drop **dashboards**. Styled after the Enterprise Spend Overview
mockups (Amex-style spend analytics).

## Stack

| Layer    | Tech                                                                  |
| -------- | --------------------------------------------------------------------- |
| Frontend | React 18 + TypeScript (Vite), Tailwind CSS v4, Recharts, react-grid-layout, Monaco editor |
| Backend  | Node.js (Express), better-sqlite3                                      |
| Database | SQLite — seeded with 60k dummy charge transactions + starter cards/dashboard |

## Run it

```bash
npm run setup   # installs server + client deps
npm run dev     # API on :4000, app on :5173
```

Open http://localhost:5173 — the seeded **Enterprise Spend Overview** dashboard has 12 cards.

Reseed demo data anytime with `npm run seed` (deterministic PRNG — same data every time).

## How it works

- **Card = SQL + mapping.** Every card row in SQLite stores its `chart_type`, `dataset`,
  builder `config` (dimension/metric/agg/filters), and `sql_text`. Dashboards only reference
  card IDs via the `dashboard_cards` mapping table (with x/y/w/h layout), so one card can live
  on many dashboards.
- **`{{filters}}` token.** Card SQL keeps a `{{filters}}` placeholder; at query time the API
  resolves it to the dashboard's segment + reporting-period conditions. That's how one stored
  card responds to Total AXP / USCS / GCS / ICS toggles and the period dropdown.
- **Three creation modes** (Card Studio):
  - **Builder** — no-code: pick chart type, dimension, aggregation, filters; SQL is generated.
  - **SQL** — Monaco editor, run arbitrary `SELECT`s against the SQLite DB (read-only connection,
    single-statement, SELECT-only enforced server-side).
  - **Copilot** — mock assistant that pattern-matches prompts ("top 5 merchants by charge
    volume") into builder configs. No LLM calls.
- **Dashboard view** — User/Admin toggle. Admin mode enables drag/resize (react-grid-layout),
  add/remove widgets from the card library, and Save persists the layout. Every card has
  Export CSV / View SQL / Share (mock) actions.
- **KPI YoY** — KPI cards automatically compare the selected window against the same window one
  year earlier and render the delta.
- **Bar list widgets** — the flagship card type from the mockups (widgets 2.1–2.5): a table
  with an inline bar column, optional sub-category column (industry → sub-industry), optional
  rank circles (Top Merchants), and per-row **$ YoY / % YoY** deltas. When a period is selected
  the API re-runs the card's SQL over the same window one year earlier (`meta.prevRows`) and
  the client joins the two result sets per row.
- **Color schemes** — each card can pick a palette (Classic Blue default, plus Emerald, Sunset,
  Violet, Ocean Teal, Slate Mono) in Card Studio; stored in the card config and applied to
  bars, lines, donuts and the bar-list gradient/rank circles.
- **Axis mapping** — the Builder exposes X-axis (category) / Y-axis (value) selectors; in SQL
  mode you can explicitly map which result column is the X axis and which numeric columns plot
  as Y series (stored as `xKey`/`yKeys` in the card config, inference is the fallback).
- **On-card controls** — any card can opt into its own segment toggle and/or reporting-period
  dropdown (Card Studio → "On-card controls"), and the card creator chooses exactly which
  segment chips (Total AXP / USCS / GCS / ICS) and period granularities (Month / Quarter /
  Full year / YTD) are offered. These override the dashboard-level filters for that widget
  only, and reset when the dashboard filters change.
- **Segment toggles** — Total AXP and USCS are single-select; GCS and ICS open a multi-select
  sub-segment breakdown (GCS: SBS/MM/G&L, ICS: Consumer/SBS/Corporate) that filters via
  `sub_segment IN (...)`.
- **Widget action panels** — every card's menu opens drill-down panels: **Export Data**
  (CSV/Excel/PDF, column picker, "filters applied" metadata), **View SQL Script** (generated
  query + parameters applied), and **Share** (recipient chips, permission, format, message,
  read-only link toggle — mock send).

## API surface

```
GET    /api/datasets                 dataset metadata + dimension values (builder dropdowns)
POST   /api/query                    ad-hoc SELECT (studio preview)
GET    /api/cards                    card library
POST   /api/cards                    create card
PUT    /api/cards/:id                update card
DELETE /api/cards/:id                delete card
GET    /api/cards/:id/data           execute a card's SQL with ?segment=&from=&to=
GET    /api/dashboards               list dashboards (+card counts)
POST   /api/dashboards               create dashboard
GET    /api/dashboards/:id           dashboard + its cards + layout
PUT    /api/dashboards/:id/items     replace card mapping + layout
DELETE /api/dashboards/:id           delete dashboard (cards survive)
```
