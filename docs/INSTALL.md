# Installing SpendBoard

Everything needed to run SpendBoard somewhere new: the components, what each one runs, versions,
ports and connections, configuration, and step-by-step installation with or without Docker.

- Just want to try it on one machine? Use the demo stack: `docker compose up --build`, then open
  http://localhost:8080 (see the README's *Try it* section).
- For how the system works, see [architecture.md](architecture.md).

---

## 1. Components

SpendBoard is four application processes and two pieces of infrastructure, plus optional services.

| # | Component | What it does | Runtime | Start command | How many |
|---|---|---|---|---|---|
| 1 | **Web server** | Serves the built web app, proxies `/api` to the API, and (in this build) acts as the sign-in provider: issues RS256 tokens and publishes `/auth/.well-known/jwks.json` | Node.js 22 | `node server/index.mjs` (in `apps/web`, after `npm run build`) | 1+ (but see note on signing keys, §7) |
| 2 | **API** | All HTTP endpoints: governance, versioning, data sources, semantic compiler, dashboard render stream, assistant. Stateless | Python 3.12 · FastAPI · Uvicorn | `uvicorn app.main:app --host 0.0.0.0 --port 8010 --workers 4` (in `backend`) | 1+ (scale freely) |
| 3 | **Worker** | Runs every card query against the data sources; refreshes REST extracts; warms dashboards | Python 3.12 · Celery | `celery -A app.worker.celery_app worker -Q interactive,refresh -c 8` | 1+ (scale for query throughput) |
| 4 | **Scheduler** | Triggers background jobs: REST refresh every 60 s, dashboard warm-up every 5 min | Python 3.12 · Celery beat | `celery -A app.worker.celery_app beat --schedule /tmp/celerybeat-schedule` | **exactly 1** |
| 5 | **PostgreSQL** | Metadata: users, cards/dashboards/sources and their versions, shares, change requests, encrypted credentials, uploaded-file records, audit log | PostgreSQL 16 | — | 1 (managed service recommended) |
| 6 | **Redis** | Card-result cache, single-flight locks, Celery job queue, completion messages, per-source concurrency counters, assistant rate limit | Redis 7 | — | 1 |
| 7 | **Shared storage** | Uploaded files and DuckDB extracts (`STORAGE_DIR`). Must be the **same filesystem for the API and all workers** | Local disk / Docker volume / NFS / EFS / Filestore | — | 1 |

Optional:

| Component | When you need it |
|---|---|
| **LLM endpoint** | Only for the assistant beyond offline mode: Ollama (OpenAI-compatible) or Azure OpenAI |
| **BigQuery emulator** (`ghcr.io/goccy/bigquery-emulator`) | Development and tests only — never in production |
| **Demo warehouse** (`demo_warehouse` database) | Only for the demo data; real installs connect their own sources |
| **Reverse proxy / load balancer** | TLS and a public hostname in front of the web server (nginx, ALB, Cloud Load Balancing, …) |

### Versions used and tested

| Component | Version |
|---|---|
| Python | 3.12 |
| Node.js | 22 (20+ works) |
| PostgreSQL | 16 |
| Redis | 7.4 |
| uv (Python package manager) | 0.12 |
| Docker / Compose | Compose v2 (for the container install) |

---

## 2. Connections and ports

```
                 HTTPS
 Browser  ───────────────▶  Web server :3001 ── /api ──▶ API :8010 ──▶ PostgreSQL :5432
                               ▲                          │  │
                               └──── JWKS (keys) ─────────┘  ├──▶ Redis :6379 ◀──── Worker(s), Scheduler
                                                             │                        │
                                                             └──▶ LLM endpoint        ├──▶ data sources
                                                                  (optional)          │    (Postgres, BigQuery,
                                                                                      │     REST APIs)
                                        API + Workers ──▶ shared STORAGE_DIR ◀────────┘
```

| From | To | Port | Why |
|---|---|---|---|
| Browser | Web server | 3001 (or 443 via your proxy) | The app, `/auth`, `/api` |
| Web server | API | 8010 | `/api` proxy |
| API | Web server | 3001 | Fetches signing keys (`JWKS_URL`) — or your identity provider instead |
| API, Worker, Scheduler | PostgreSQL | 5432 | Metadata |
| API, Worker, Scheduler | Redis | 6379 | Cache, queue, locks |
| Worker (and API for "Test connection" / previews) | Data sources | Postgres 5432, `bigquery.googleapis.com:443`, REST API hosts | Card queries |
| API | LLM endpoint | e.g. 11434 (Ollama) or 443 (Azure) | Assistant |
| API, Worker | Shared storage | — | Uploads and extracts |

Only the web server needs to be reachable from users. Keep everything else on a private network.

---

## 3. Software dependencies

You don't install these by hand — `uv sync` and `npm ci` do, from the lock files — but this is what gets installed and why.

### Backend (`backend/pyproject.toml`, locked in `backend/uv.lock`)

| Package | Locked version | Used for |
|---|---|---|
| fastapi, uvicorn[standard] | 0.142.2, 0.54.0 | HTTP API and server |
| pydantic, pydantic-settings | 2.13.5 | Typed specs and settings |
| sqlalchemy[asyncio], asyncpg, alembic | 2.1.1, 0.31.0, 1.20.0 | Metadata database access and migrations; asyncpg also runs Postgres data-source queries |
| pyjwt[crypto], httpx | 2.15.1, 0.28.1 | Token verification; JWKS and REST fetches |
| sqlglot | 30.21.0 | Parsing, validating and quoting SQL for Postgres, DuckDB and BigQuery |
| redis | 6.4.0 | Cache, locks, rate limit |
| celery[redis] | 5.6.3 | Workers and scheduler |
| duckdb, pyarrow, openpyxl, python-multipart | 1.5.6, 25.0.1, 3.1.5, 0.0.32 | File uploads and REST extracts |
| cryptography | 50.0.2 | Encrypting stored credentials |
| google-cloud-bigquery | 3.46.1 | BigQuery data sources |
| openai | 3.22.1 | Assistant (OpenAI chat-completions format: Ollama, Azure OpenAI) |

Development only: pytest, pytest-asyncio, locust.

### Web (`apps/web/package.json`, locked in `package-lock.json`)

| Package | Used for |
|---|---|
| react, react-dom, react-router-dom | The app |
| recharts, react-grid-layout, @monaco-editor/react | Charts, dashboard grid, SQL editor |
| express, http-proxy-middleware, jose | The web server: static files, `/api` proxy, token signing |
| vite, typescript, tailwindcss | Build only |

No system libraries are needed beyond what the official `python:3.12-slim` and `node:22-alpine` images include.

---

## 4. Configuration

All backend settings are environment variables (or `backend/.env`). The API, workers and scheduler must use the
**same values**. Defaults suit local development only.

### Required for any real install

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://spendboard:…@db:5432/spendboard` | Metadata database |
| `REDIS_URL` | `redis://redis:6379/0` | |
| `SECRET_KEY` | 32+ random characters | Encrypts stored credentials. **Same value everywhere; never change it** after credentials are stored (they become unreadable) |
| `STORAGE_DIR` | `/data/storage` | Shared by API and workers |
| `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | `http://web:3001/auth/.well-known/jwks.json`, `spendboard-auth`, `spendboard-api` | Your identity provider's values when you replace the simulated one |

### Limits and behaviour

| Variable | Default | Meaning |
|---|---|---|
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | 5 / 10 | Per process. Keep (API processes + worker processes) × (pool + overflow) below Postgres `max_connections` |
| `QUERY_MAX_ROWS` / `QUERY_TIMEOUT_S` | 1000 / 30 | Row cap and timeout ceiling for card queries |
| `MAX_UPLOAD_MB` | 50 | File uploads |
| `REST_MAX_RECORDS` / `REST_MAX_RESPONSE_MB` | 100000 / 20 | REST data sources |
| `ALLOW_PRIVATE_NETWORK_SOURCES` | false | `true` lets non-admins connect sources to private addresses — development only |
| `EXECUTION_MODE` | celery | `inline` runs queries inside the API (no worker) — tests/demos only |
| `STALE_GRACE_S` / `RESULT_WAIT_S` | 21600 / 60 | How long stale results may be served; how long a request waits for a query |
| `BREAKER_FAILURES` / `BREAKER_OPEN_S` | 5 / 30 | Pause a failing data source |

### Assistant

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | offline | `offline`, `openai` (any OpenAI-compatible endpoint, e.g. Ollama) or `azure` |
| `LLM_MODEL` | — | Model name, or the Azure deployment name |
| `LLM_BASE_URL` | — | e.g. `http://ollama:11434/v1` |
| `LLM_API_KEY` | — | Azure / OpenAI key (Ollama ignores it) |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` | — / 2024-10-21 | Azure OpenAI |
| `LLM_TEMPERATURE` / `LLM_TIMEOUT_S` / `LLM_MAX_TOOL_ROUNDS` | 0.1 / 60 / 6 | |
| `ASSISTANT_REQUESTS_PER_MINUTE` | 20 | Per user |

### Demo and development only

| Variable | Meaning |
|---|---|
| `WAREHOUSE_ADMIN_URL`, `DEMO_WAREHOUSE_HOST`, `DEMO_WAREHOUSE_PORT`, `DEMO_WAREHOUSE_PASSWORD` | The demo warehouse the seed loads and the demo source reads |
| `BIGQUERY_EMULATOR_HOST` | Sends **every** BigQuery source to an emulator. Must be unset in production |

### Web server

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3001 | Listen port |
| `API_URL` | http://localhost:8010 | Where `/api` is proxied |

---

## 5. Install with Docker (recommended)

The repository builds two images from the same source tree:

| Image | Built from | Containers that run it |
|---|---|---|
| backend | `backend/Dockerfile` | api, worker, scheduler — same image, different commands |
| web | `apps/web/Dockerfile` | web |

Plus the public images `postgres:16-alpine` and `redis:7-alpine` (or managed services).

### Single host

`compose.yaml` at the repository root is a complete single-host install. For anything beyond testing, copy it and
change:

1. `SECRET_KEY` — a real random value (and keep it safe).
2. Remove `BIGQUERY_EMULATOR_HOST` and the `bigquery` service.
3. Set `ALLOW_PRIVATE_NETWORK_SOURCES: "false"`.
4. Replace the Postgres password (or point `DATABASE_URL` at a managed database).
5. The `api` command runs `python -m app.seed`, which loads demo content. Remove it for a clean install — keep
   `alembic upgrade head`.
6. Put TLS in front of the `web` port.

```bash
docker compose up -d --build
docker compose ps          # api should become "healthy"
```

### Kubernetes / other orchestrators

Map each component to a deployment:

| Deployment | Image | Command | Replicas | Probes |
|---|---|---|---|---|
| web | web | `node server/index.mjs` | 1 (see §7) | HTTP GET `/auth/users` |
| api | backend | `uvicorn app.main:app --host 0.0.0.0 --port 8010 --workers 2` | 2+ | HTTP GET `/healthz` |
| worker | backend | `celery -A app.worker.celery_app worker -Q interactive,refresh -c 8` | 1+ | process liveness |
| scheduler | backend | `celery -A app.worker.celery_app beat --schedule /tmp/celerybeat-schedule` | **1** | process liveness |
| migrate (Job) | backend | `alembic upgrade head` | run once per release, before api | — |

- Mount the same `STORAGE_DIR` volume (ReadWriteMany) into api and worker pods.
- Give api, worker and scheduler the same environment (a shared ConfigMap + Secret).
- To isolate background work, run a second worker deployment with `-Q refresh` and the main one with `-Q interactive`.

---

## 6. Install without Docker (Linux server)

### 6.1 System packages

```bash
# Ubuntu 24.04 example
sudo apt-get update
sudo apt-get install -y postgresql-16 redis-server git curl
curl -LsSf https://astral.sh/uv/install.sh | sh                  # uv (installs Python 3.12 on demand)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

### 6.2 Databases

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE spendboard LOGIN PASSWORD 'change-me';
CREATE DATABASE spendboard OWNER spendboard;
SQL
```

For the demo data as well, also run `infra/postgres/init.sql` (creates `demo_warehouse` and the read-only
`warehouse_reader` role).

### 6.3 Application

```bash
git clone https://github.com/sid7631/reusable-card-dashboard /opt/spendboard
cd /opt/spendboard && git checkout feature/governance-versioning-datasources

# backend
cd backend
uv sync --frozen --no-dev
cp .env.example .env            # then edit: DATABASE_URL, REDIS_URL, SECRET_KEY, STORAGE_DIR, JWKS_URL …
uv run alembic upgrade head
uv run python -m app.seed       # optional: demo content (needs the demo warehouse)

# web
cd ../apps/web
npm ci
npm run build                   # produces dist/, which the web server serves
```

### 6.4 Run the processes (systemd)

One unit per process. Example for the API — the worker, scheduler and web server follow the same pattern with
the commands from §1.

```ini
# /etc/systemd/system/spendboard-api.service
[Unit]
Description=SpendBoard API
After=network.target postgresql.service redis-server.service

[Service]
WorkingDirectory=/opt/spendboard/backend
EnvironmentFile=/opt/spendboard/backend/.env
ExecStart=/opt/spendboard/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8010 --workers 4
Restart=always
User=spendboard

[Install]
WantedBy=multi-user.target
```

| Unit | `WorkingDirectory` | `ExecStart` |
|---|---|---|
| spendboard-api | `backend` | `.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8010 --workers 4` |
| spendboard-worker | `backend` | `.venv/bin/celery -A app.worker.celery_app worker -Q interactive,refresh -c 8` |
| spendboard-scheduler | `backend` | `.venv/bin/celery -A app.worker.celery_app beat --schedule /var/lib/spendboard/celerybeat-schedule` |
| spendboard-web | `apps/web` | `/usr/bin/node server/index.mjs` with `Environment=PORT=3001 API_URL=http://127.0.0.1:8010` |

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spendboard-api spendboard-worker spendboard-scheduler spendboard-web
```

### 6.5 Reverse proxy

Put nginx (or similar) in front of the web server for TLS. Dashboards load over a streamed response
(server-sent events), so **turn off response buffering** for `/api`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;          # dashboard render stream
    proxy_read_timeout 120s;
    client_max_body_size 60m;     # file uploads (MAX_UPLOAD_MB + headroom)
}
```

---

## 7. Production checklist

- [ ] **Identity**: replace the simulated sign-in with your identity provider. Point `JWKS_URL`, `JWT_ISSUER` and
  `JWT_AUDIENCE` at it and map its role claim to `admin`. Until then, the web server generates its signing key on
  first start and keeps it in `apps/web/server/.keys/`; with more than one web replica, every replica must share
  that key file (or tokens from one won't verify via another's JWKS).
- [ ] **`SECRET_KEY`**: a long random value, identical across api, worker and scheduler, stored in your secret
  manager, backed up. Losing or changing it makes stored data-source credentials unreadable.
- [ ] `ALLOW_PRIVATE_NETWORK_SOURCES=false`; `BIGQUERY_EMULATOR_HOST` unset; no demo seed.
- [ ] **Scheduler**: exactly one instance.
- [ ] **Shared storage** mounted at the same `STORAGE_DIR` for api and all workers; backed up.
- [ ] **Postgres**: backups of the `spendboard` database (versions, credentials, audit log live there). Size
  `max_connections` for (api processes + worker processes) × (`DB_POOL_SIZE` + `DB_MAX_OVERFLOW`).
- [ ] **Redis**: losing it only loses cached results and queued jobs (they are recomputed). For large caches set
  `maxmemory` with `volatile-lru` (cache entries have TTLs; locks and queue keys should not be evicted first), or run
  the broker and the cache on separate Redis instances.
- [ ] **Data-source accounts**: read-only database roles; BigQuery service accounts with only *BigQuery Data Viewer* +
  *BigQuery Job User*; sensible scan caps per BigQuery source.
- [ ] **TLS** at the edge; only the web server exposed.
- [ ] **Logs**: collect stdout/stderr of all four processes.
- [ ] **Sizing**: start with 2 API replicas × 2 Uvicorn workers and 1–2 worker containers × 8 processes; see
  [loadtest.md](loadtest.md) for measured throughput and how to re-run the load test against your install.

---

## 8. Check the install

```bash
curl -s http://<web-host>:3001/auth/users          # web server up (simulated sign-in)
curl -s http://<api-host>:8010/healthz              # {"status":"ok"}
```

Then sign in, open a dashboard and confirm cards load (that exercises Redis, a worker and a data source end to end).

To run the backend test suite on a machine with the source tree (needs Postgres and Redis reachable as configured
in `backend/tests/conftest.py`):

```bash
cd backend && uv sync && uv run pytest
```
