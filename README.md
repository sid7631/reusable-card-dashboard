# SpendBoard — Governed, Reusable Cards & Dashboards

Build chart **cards** bound to a data source + SQL, store them once, and reuse them across any number of
drag-and-drop **dashboards**. Cards, dashboards and data sources are **versioned**, live in a **private**
space or the **global** library, and are published through admin approval.

Design and roadmap: [docs/architecture.md](docs/architecture.md).

## Stack

| Layer | Tech |
| --- | --- |
| Web | React 18 + TypeScript (Vite), Tailwind v4, Recharts, react-grid-layout, Monaco |
| Auth (simulated SSO) | Node service in the web deployment — issues RS256 JWTs, publishes JWKS |
| API | Python 3.12, FastAPI, SQLAlchemy 2 (async), Alembic, SQLGlot |
| Metadata | Postgres 16 |
| Cache / queue | Redis 7 (wired in from phase 5) |
| Demo data | Postgres `demo_warehouse` — 60k charge transactions, queried through a read-only role |
| Extracts | DuckDB (+ PyArrow) for uploaded files and REST data, stored under `backend/storage/` |

```
apps/web/            SPA + server/index.mjs (auth + production static/proxy)
backend/app/         FastAPI: core (config, db, auth), governance, connectors, execution, api, seed
backend/alembic/     migrations
infra/               docker-compose (postgres, redis, api, web) + postgres init
docs/                architecture
```

## Run it (local development)

Prerequisites: Docker, Node 20+, [uv](https://docs.astral.sh/uv/).

```bash
npm run setup     # web deps + Python venv
cp backend/.env.example backend/.env
npm run dev       # postgres+redis in Docker, migrate, seed, API on :8010, web on :5173 (auth on :3001)
```

Open http://localhost:5173 and pick an account: **Avery Admin** (admin) or **Riley / Jordan Analyst** (users).

Full containerised stack instead: `npm run stack` → http://localhost:3001.

Host ports default to Postgres **5433**, Redis **6380**, API **8010** to avoid clashing with local services;
override with `POSTGRES_PORT`, `REDIS_PORT`, `API_PORT`, `WEB_PORT`.

Other scripts: `npm test` (backend tests), `npm run seed:reset` (rebuild demo data and starter assets),
`npm run infra:down`.

## How it works (current state)

- **Assets & versions.** A card, dashboard or data source is an `asset` (owner, scope, lineage) plus immutable
  `asset_versions` holding a typed spec. Every save appends a version; a database trigger rejects edits to
  existing versions.
- **Pinning.** A dashboard version pins card versions, and a card version pins a data-source version — editing a
  card never silently changes a dashboard. Dashboards flag cards with a newer version ("Update").
- **Scopes & permissions.** New assets are private to their creator. Global assets are read-only for users and
  editable by admins. Owners share private assets with specific people as `view` (open + render) or `edit` (also
  save new versions); revoking is immediate. Viewers of a shared dashboard can render its cards without access to
  the cards themselves.
- **History.** Every card and dashboard has a version history with per-version changes, comparison against the
  current version (structural diff, line diff for SQL), and restore — which appends a new version rather than
  rewriting history.
- **Publishing (PR-style).** Users never edit global assets in place: **Edit a copy** forks a private copy that
  remembers which global version it came from. **Propose changes** (copies) or **Request publish** (new assets)
  opens a change request; private cards and data sources the asset uses are bundled in automatically. Admins review
  in **Approvals** — per-item diffs against global, live card previews, approve or reject with a comment. Approval
  publishes in one transaction and rewrites references from private to the new global versions; the requester is
  recorded as the author.
- **Merging.** If global moved since the copy was made, changes merge three-way (per JSON path, per dashboard item,
  per SQL line). Conflicts block approval until the requester runs **Update from global**, choosing a side per
  conflict — the open request picks up the result automatically.
- **Card updates on dashboards.** When a pinned card has a newer version, the dashboard shows an "Update" chip and a
  banner; **Update all** re-pins them as a new dashboard version.
- **Data sources.** Onboard **Postgres** (queried in place, read-only), **REST APIs** (bearer / API-key / basic auth,
  page pagination, records path — fetched into a DuckDB extract refreshed after the cache TTL) and **CSV / Excel /
  JSON** uploads (ingested into DuckDB; each Excel sheet is a table, nested JSON is flattened). Testing a connection
  proposes a **semantic model** — business labels, descriptions, dimensions, measures, time dimension — that the card
  builder uses. Sources are versioned and published through the same approval flow as cards.
- **Credentials & safety.** Passwords/tokens are stored encrypted (`SECRET_KEY`) and referenced as `sec:<id>`; the
  API never returns them. A stored credential can only be reused against the endpoint it was saved for, so a copy of
  a published source can't redirect it to another host; only admins may reference server settings (`env:`). DuckDB
  extracts are opened read-only with external access disabled. Non-admins can't target private network addresses
  unless `ALLOW_PRIVATE_NETWORK_SOURCES=true` (local dev).
- **Semantic queries.** Builder cards are stored as measures × dimensions in business terms (model measures or
  ad-hoc aggregates, time grains day → year, static filters, sort, limit) and compiled server-side to Postgres or
  DuckDB SQL. Model measure expressions must be plain aggregates. The same `/api/semantic/*` endpoints are the shape
  future LLM tools will call. Raw-SQL cards keep working with a `{{filters}}` token.
- **Filters.** Dashboards define their filters: a dimension, single/multi select, a parent (options cascade from the
  parent's selection), a lock, and a default — plus a period filter bound to each source's time dimension. Every card
  binds filters through its own source's model; filters a source can't apply are reported and the card shows
  "Partly filtered". Cards can expose their own filter dropdowns that override the dashboard for that card, except
  where the dashboard filter is locked.
- **Auth.** The SPA gets a signed token from `/auth/token` and sends it as a Bearer token; FastAPI verifies it
  against the JWKS and provisions the user on first request.
- **Safe queries.** Card SQL is parsed with SQLGlot (exactly one read-only `SELECT`), dashboard filters are bound as
  query parameters at the `{{filters}}` token, and execution runs in a read-only transaction with a statement
  timeout and a row cap.
- **YoY.** With a period selected, the card's query also runs for the same window a year earlier — a single delta
  for KPIs, per-row deltas for bar lists.

## API (selection)

```
GET  /api/me
GET  /api/datasets                 builder metadata per visible data source
POST /api/query                    studio preview {sql, data_source_id}
GET  /api/cards?scope=global|private|shared      POST /api/cards
GET  /api/cards/:id[?version_id]   PUT /api/cards/:id (new version)   DELETE (archive)
GET  /api/cards/:id/data?dashboard_id&version_id&filters={json}&from&to   → rows + applied/ignored filters
GET  /api/dashboards               POST /api/dashboards
GET  /api/dashboards/:id           PUT /api/dashboards/:id/items (new version)   DELETE (archive)
GET  /api/users?q=                 directory, for sharing

GET  /api/data-sources[?scope]     POST /api/data-sources {name, spec, credentials?}
GET  /api/data-sources/:id         PUT /api/data-sources/:id (new version)   DELETE (archive)
POST /api/data-sources/test        {spec, credentials?, data_source_id?} → tables, sample, suggested model
POST /api/files                    multipart upload (CSV / XLSX / JSON) → tables, suggested model

POST /api/dashboards/:id/apply-updates           re-pin cards to their latest versions
PUT  /api/dashboards/:id/filters                  filter definitions (new version)
GET  /api/dashboards/:id/filter-options/:filter?selections=   cascading options
GET  /api/dashboards/:id/filterable               dimensions across the dashboard's sources
GET  /api/cards/:id/filter-options?dimension&filters          options for card-level controls

GET  /api/semantic/catalog/:source_id             datasets, dimensions, measures (business names)
POST /api/semantic/compile {data_source_id, query, editable?}
POST /api/semantic/query   {data_source_id, query, filters, date_from, date_to}

GET  /api/change-requests?status=          admin: queue · user: own      GET /api/change-requests/summary
POST /api/change-requests {kind, asset_id, title, description}
GET  /api/change-requests/:id              items, diffs, conflicts, permissions
POST /api/change-requests/:id/approve|reject|withdraw|update
GET  /api/change-requests/:id/items/:item/data     preview a proposed card

# governance — same for /api/cards, /api/dashboards, /api/data-sources
GET    /:kind/:id/versions          GET /:kind/:id/versions/:no
GET    /:kind/:id/diff?from_no&to_no
POST   /:kind/:id/restore/:no
POST   /:kind/:id/fork              private copy of a global asset (reused if one exists)
GET    /:kind/:id/rebase            preview "update from global"     POST /:kind/:id/rebase {resolutions}
GET    /:kind/:id/shares            PUT /:kind/:id/shares/:user_id {permission}   DELETE /:kind/:id/shares/:user_id
```

Interactive docs: http://localhost:8010/docs.
