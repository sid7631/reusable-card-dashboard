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
  editable by admins. Private assets can be shared with users as `view` or `edit` (API model in place; sharing UI
  arrives with phase 1).
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
GET  /api/cards/:id/versions
GET  /api/cards/:id/data?dashboard_id&version_id&segment&sub_segments&from&to
GET  /api/dashboards               POST /api/dashboards
GET  /api/dashboards/:id           PUT /api/dashboards/:id/items (new version)   DELETE (archive)
GET  /api/dashboards/:id/versions
```

Interactive docs: http://localhost:8010/docs.
