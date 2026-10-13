# SpendBoard — Governed, Reusable Cards & Dashboards

Build chart **cards** bound to a data source + SQL, store them once, and reuse them across any number of
drag-and-drop **dashboards**. Cards, dashboards and data sources are **versioned**, live in a **private**
space or the **global** library, and are published through admin approval.

Design and roadmap: [docs/architecture.md](docs/architecture.md).
Installing it somewhere else (components, ports, settings, Docker / Kubernetes / bare-metal steps): [docs/INSTALL.md](docs/INSTALL.md).

## Try it (Docker only)

The only requirement is Docker (Docker Desktop on Mac/Windows, or Docker Engine with Compose v2 on Linux).

```bash
git clone https://github.com/sid7631/reusable-card-dashboard
cd reusable-card-dashboard
git checkout feature/governance-versioning-datasources
docker compose up --build
```

The first build takes a few minutes; later starts take about 30 seconds. Then open **http://localhost:8080** and
sign in as one of the demo accounts:

| Account | Role | Try |
| --- | --- | --- |
| Avery Admin | admin | Approvals queue, conversations on requests, "Request changes", choosing the published version, card updates waiting on the global overview |
| Morgan Admin | admin | A second reviewer: approvals that affect other open requests ("approving this also affects #3"), a version override (v5), a rejection after discussion |
| Riley Analyst | user | Private copies numbered after their global version (2.2), a draft card (0.2), a request in review, a personal dashboard with a card update waiting, shared with Jordan |
| Jordan Analyst | user | A request sent back with changes requested and a conflict to resolve (Resolve conflicts → Send back for review), unread messages, a rejected dashboard |

What's included:

- **Enterprise Spend Overview** — the demo dashboard on Postgres (60,000 card transactions).
- **BigQuery Demo** — the same data in a bundled BigQuery emulator, queried through the BigQuery SQL dialect.
- **Budget Planning** — an uploaded CSV (budget and forecast per sub-segment), and **Merchant Partners** — a REST API
  source (the API's own `/demo/merchant-partners` endpoint). Every source type has example cards to start new cards from.
- A walkthrough already played by the four accounts: copies, drafts, change requests in every state, shares.
- The floating **dashboard assistant**, in offline mode (no model needed).
- Data sources you can add yourself: CSV / Excel / JSON uploads, REST APIs, Postgres, BigQuery (emulator).

Useful commands:

```bash
docker compose up --build -d     # run in the background
docker compose logs -f api       # follow the API log (also: worker, web)
docker compose down              # stop, keep data
docker compose down -v           # stop and delete all demo data (fresh start next time)
docker compose exec api python -m app.seed --reset   # same as npm run seed:reset (then: docker compose restart)
PORT=9000 docker compose up      # use another port than 8080
```

To try the assistant with a real model, start the stack with a model configured, e.g. Ollama on your machine:
`LLM_PROVIDER=openai LLM_BASE_URL=http://host.docker.internal:11434/v1 LLM_MODEL=qwen2.5:7b docker compose up`.

This stack is for testing only: it uses demo passwords and allows connections to private network addresses.

## Stack

| Layer | Tech |
| --- | --- |
| Web | React 18 + TypeScript (Vite), Tailwind v4, Recharts, react-grid-layout, Monaco. Server state in TanStack Query (`src/lib/queries.ts`; any write refreshes what is on screen); dashboard editing in a reducer (`src/lib/dashboardEditor.ts`) |
| Auth (simulated SSO) | Node service in the web deployment — issues RS256 JWTs, publishes JWKS |
| API | Python 3.12, FastAPI, SQLAlchemy 2 (async), Alembic, SQLGlot |
| Metadata | Postgres 16 |
| Cache / queue | Redis 7 (result cache, locks, broker) + Celery workers and beat; queue is swappable — see [INSTALL §4b](docs/INSTALL.md#4b-the-job-queue-celery-and-alternatives) |
| Demo data | Postgres `demo_warehouse` — 60k charge transactions, queried through a read-only role |
| Extracts | DuckDB (+ PyArrow) for uploaded files and REST data, stored on local disk (`backend/storage/`) or S3 — `STORAGE_BACKEND`, see [INSTALL §4a](docs/INSTALL.md#4a-file-storage-local-disk-or-s3) |

```
apps/web/            SPA + server/index.mjs (auth + production static/proxy)
backend/app/         FastAPI: core (config, db, auth), governance, connectors, execution, api, seed
backend/alembic/     migrations
compose.yaml         the whole app in containers, for testers (docker compose up --build)
infra/               dev infrastructure (postgres, redis, bigquery emulator) + postgres init
docs/                architecture
```

## Run it (local development)

Prerequisites: Docker, Node 20+, [uv](https://docs.astral.sh/uv/).

```bash
npm run setup     # web deps + Python venv
cp backend/.env.example backend/.env
npm run dev       # postgres+redis in Docker, migrate, seed, API :8010, Celery worker + beat, web :5173 (auth :3001)
npm run seed:reset  # any time: wipe and rebuild the demo data (deletes what you created while testing)
```

Open http://localhost:5173 and pick an account: **Avery / Morgan Admin** (admins) or **Riley / Jordan Analyst** (users).

Full containerised stack instead: `docker compose up --build` → http://localhost:8080 (see *Try it* above).

Host ports default to Postgres **5433**, Redis **6380**, API **8010** to avoid clashing with local services;
override with `POSTGRES_PORT`, `REDIS_PORT`, `API_PORT`, `WEB_PORT`.

Other scripts: `npm test` (backend tests), `npm run seed:reset` (rebuild demo data and starter assets),
`npm run infra:down`, `npm run loadtest` (Locust UI), `npm run infra:bigquery` (local BigQuery emulator for
development and the BigQuery tests; set `BIGQUERY_EMULATOR_HOST=http://localhost:9050` to point BigQuery sources at it). Set `EXECUTION_MODE=inline` to run card queries inside the API
process without a worker.

### After pulling new changes

New features sometimes need new database tables or columns, and a new demo story. If the app shows errors or the
demo looks out of date after you pull, refresh your database:

```bash
npm run migrate        # add the new tables and columns — keeps your data
npm run seed:reset     # wipe and rebuild the demo data — deletes anything you created while testing
```

Then restart `npm run dev` (the API and workers cache data by id, and a reset reuses ids).

- **Brand-new setup:** nothing to do — `npm run dev` already migrates and seeds an empty database.
- **Docker stack:** it migrates by itself on start-up but never wipes existing data. To get the new demo, start
  fresh with `docker compose down -v` (deletes the Docker demo data), then `docker compose up --build`.
- The demo story (Morgan, the conversations, Jordan's "changes requested" request) is only created on a database
  with no change requests, which is why the reset is needed to see it.
- If the BigQuery emulator stops (Docker may stop it when memory runs low), restart it with
  `npm run infra:bigquery`, then run `npm run seed` to load its demo data again — it keeps data only in memory.

## How it works (current state)

- **Assets & versions.** A card, dashboard or data source is an `asset` (owner, scope, lineage) plus immutable
  `asset_versions` holding a typed spec. Every save appends a version; a database trigger rejects edits to
  existing versions. Versions read as **major.minor**: global versions are whole numbers (v3); a private copy of
  global v3 saves 3.1, 3.2, … and continues from the new base after "Update from global"; a private asset that was
  never published saves 0.1, 0.2, … Approval publishes the next whole version — the admin may pick a higher one.
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
  recorded as the author. Each request has a **conversation**: admins and the requester exchange messages without
  deciding anything, with unread counts in the list and sidebar. **Request changes** sends a request back to the
  requester but keeps it open; they update their copy and **Send back for review**. A global asset shows which open
  requests would change it, and a request warns when approving it affects another open request on the same asset.
- **Merging.** If global moved since the copy was made, changes merge three-way (per JSON path, per dashboard item,
  per SQL line). Conflicts block approval until the requester resolves them (**Resolve conflicts** on the request,
  or **Update from global** on the copy), choosing "Keep mine" or "Take global" per conflict; a card's builder
  settings follow its query's choice, and SQL conflicts show just the changed lines. The open request picks up the
  result automatically, and the copy is renumbered after the global version it is now based on (e.g. 2.1).
- **Card updates on dashboards.** When a pinned card has a newer version, the dashboard shows an "Update" chip and a
  banner. The chip (or the card's name in the banner) shows what changed and updates just that card; **Update all**
  re-pins every one. Either way the result is a new dashboard version.
- **Changing a card's data source.** While editing, "change" next to the source moves the card to another one. It
  first says what carries over: builder cards keep the fields the new source also has (others reset); SQL cards keep
  their SQL and must run successfully on the new source before saving. Dashboards keep the old version until updated.
- **Deleting.** Delete first shows what it affects (dashboards or cards using it, people's copies, open requests).
  Deleting hides the asset: everything already using it keeps working with its pinned version, marked "Deleted",
  and can still be edited — it just can't be added anywhere new. Copies are kept and would be published as new
  assets; open requests to change it can't be approved. Each list has a **Deleted** tab to restore (global: admins;
  private: the owner).
- **New cards** start by choosing a data source, then an example card on it (pre-filled, saved as your own) or a blank card.
- **Data sources.** Onboard **Postgres** (queried in place, read-only), **BigQuery** (queried in place with typed
  parameters, a per-query bytes-billed cap, job timeouts; service-account key or — admins only — the server's Google
  identity), **REST APIs** (bearer / API-key / basic auth,
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
  ad-hoc aggregates, time grains day → year, static filters, sort, limit) and compiled server-side to Postgres,
  DuckDB or BigQuery SQL — quoting, parameters (`$1` vs `@p1`), list filters (`= ANY` vs `IN UNNEST`), date functions
  and DATE/DATETIME/TIMESTAMP windows all come from one dialect module (`backend/app/semantic/dialects.py`). Model measure expressions must be plain aggregates. The same `/api/semantic/*` endpoints are the shape
  future LLM tools will call. Raw-SQL cards keep working with a `{{filters}}` token.
- **Filters.** Dashboards define their filters: a dimension, single/multi select, a parent (options cascade from the
  parent's selection), a lock, and a default — plus a period filter bound to each source's time dimension. Every card
  binds filters through its own source's model; filters a source can't apply are reported and the card shows
  "Partly filtered". Cards can expose their own filter dropdowns that override the dashboard for that card, except
  where the dashboard filter is locked.
- **Execution at scale.** Card results are cached in Redis, keyed by the immutable card version, source version and
  filters, and shared by every viewer. Concurrent requests for the same view run one query (single-flight); past
  their TTL, results are served immediately as stale and refreshed in the background. Queries run on Celery workers
  under a cluster-wide concurrency cap per source endpoint, with a circuit breaker for failing sources. A dashboard
  loads all cards in **one streamed request** (`POST /render`, server-sent events), each card showing "as of".
  Celery beat refreshes REST extracts and pre-computes global dashboards' default views. Baseline numbers:
  [docs/loadtest.md](docs/loadtest.md).
- **Dashboard assistant.** A floating chat button on every dashboard answers questions about the cards as they are
  shown (same filters, same cached results), cites the cards it used ("From …" — click to jump to the card), and
  offers filter buttons ("Filter to GCS →"). With a model configured it uses the **OpenAI chat-completions format**
  — Ollama locally (`LLM_PROVIDER=openai`, `LLM_BASE_URL=http://localhost:11434/v1`) or Azure OpenAI
  (`LLM_PROVIDER=azure`) — with server-side tools: `query_data` (semantic queries, only against the dashboard's own
  sources, ≤50 rows), `list_dimension_values`, `get_card` (re-run a card with other filters, cached) and
  `suggest_filter` (a button the user may click). The model gets the semantic catalog and the on-screen
  aggregates, never raw source data. Without a model (`LLM_PROVIDER=offline`, the default) it answers common
  questions — totals, leaders, growth, concentration, overview — from the figures on screen. See `backend/.env.example`.
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

POST /api/dashboards/:id/render   {items: [{item_id, filters, date_from, date_to}]} → text/event-stream
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

GET  /api/assistant/config                        offline | llm, model
POST /api/dashboards/:id/assistant  {question, history, items (as shown), filter_summary}
                                    → answer, sources (cards cited), actions (filter buttons), tool_calls

# governance — same for /api/cards, /api/dashboards, /api/data-sources
GET    /:kind/:id/versions          GET /:kind/:id/versions/:no
GET    /:kind/:id/diff?from_no&to_no
POST   /:kind/:id/restore/:no
POST   /:kind/:id/fork              private copy of a global asset (reused if one exists)
GET    /:kind/:id/rebase            preview "update from global"     POST /:kind/:id/rebase {resolutions}
GET    /:kind/:id/shares            PUT /:kind/:id/shares/:user_id {permission}   DELETE /:kind/:id/shares/:user_id
```

Interactive docs: http://localhost:8010/docs.
