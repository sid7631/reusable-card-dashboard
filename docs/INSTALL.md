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
| 6 | **Redis** | Card-result cache, single-flight locks, Celery job queue (unless `CELERY_BROKER_URL` points elsewhere), completion messages, per-source concurrency counters, current-REST-extract pointers, assistant rate limit | Redis 7 | — | 1 |
| 7 | **File storage** | Uploaded files and DuckDB extracts. Either a **shared filesystem** for the API and all workers (`STORAGE_BACKEND=local`, `STORAGE_DIR`), or an **S3 bucket** (`STORAGE_BACKEND=s3`), in which case each process only needs local scratch/cache disk | Docker volume / NFS / EFS / Filestore, or S3 / MinIO / R2 / any S3-compatible store | — | 1 |

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
| boto3 | 1.43.108 | S3 file storage (only used when `STORAGE_BACKEND=s3`) |
| duckdb, pyarrow, openpyxl, python-multipart | 1.5.6, 25.0.1, 3.1.5, 0.0.32 | File uploads and REST extracts |
| cryptography | 50.0.2 | Encrypting stored credentials |
| google-cloud-bigquery | 3.46.1 | BigQuery data sources |
| openai | 3.22.1 | Assistant (OpenAI chat-completions format: Ollama, Azure OpenAI) |

Development only: pytest, pytest-asyncio, locust, moto (S3 emulator for tests).

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
| `STORAGE_BACKEND` | `local` or `s3` | Where uploads and extracts live — see [§4a](#4a-file-storage-local-disk-or-s3) |
| `STORAGE_DIR` | `/data/storage` | `local`: shared by API and workers. `s3`: per-process cache and scratch only |
| `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | `http://web:3001/auth/.well-known/jwks.json`, `spendboard-auth`, `spendboard-api` | Your identity provider's values when you replace the simulated one |

### Limits and behaviour

| Variable | Default | Meaning |
|---|---|---|
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | 5 / 10 | Per process. Keep (API processes + worker processes) × (pool + overflow) below Postgres `max_connections` |
| `QUERY_MAX_ROWS` / `QUERY_TIMEOUT_S` | 1000 / 300 | Row cap, and the server-wide ceiling on query time. Each data source sets its own timeout (default 30 s; up to 5 min, e.g. for BigQuery) in its editor. Workers' task time limits and how long requests wait follow from these |
| `MAX_UPLOAD_MB` | 50 | File uploads |
| `REST_MAX_RECORDS` / `REST_MAX_RESPONSE_MB` | 100000 / 20 | REST data sources |
| `ALLOW_PRIVATE_NETWORK_SOURCES` | false | `true` lets non-admins connect sources to private addresses — development only |
| `EXECUTION_MODE` | celery | `inline` runs queries inside the API (no worker) — tests/demos only |
| `CELERY_BROKER_URL` | = `REDIS_URL` | Job-queue broker; `amqp://…` (RabbitMQ) or `sqs://…` move the queue off Redis — see [§4b](#4b-the-job-queue-celery-and-alternatives) |
| `STALE_GRACE_S` / `RESULT_WAIT_S` | 21600 / 60 | How long stale results may be served; the minimum time a request waits for a query (it always waits at least the source's timeout + 25 s) |
| `BREAKER_FAILURES` / `BREAKER_OPEN_S` | 5 / 30 | Pause a failing data source |
| `STUCK_AFTER_S` | `QUERY_TIMEOUT_S` + 60 | Workers count as stuck after this long without progress while card jobs wait — see [§4c](#4c-health-checks-and-alerts) |
| `QUEUE_WARN_DEPTH` | 200 | Queued jobs above this mark the system *degraded* |

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

## 4a. File storage: local disk or S3

All code reads and writes files through one interface (`backend/app/core/storage.py`) using **keys** such as
`uploads/12.csv`, `files/12.duckdb` or `rest/<version>-<hash>/<timestamp>.duckdb` — never filesystem paths. The
database stores keys too, so switching backends is configuration only.

| | `STORAGE_BACKEND=local` (default) | `STORAGE_BACKEND=s3` |
|---|---|---|
| Where files live | `STORAGE_DIR` on a filesystem every API and worker process mounts | `s3://S3_BUCKET/S3_PREFIX/<key>` |
| Local disk needed | The shared volume | Scratch + cache only (`STORAGE_DIR`, sized by `STORAGE_CACHE_MAX_MB`, default 5000) |
| Reads | The file directly | First read downloads to the process's cache; later reads use the cached copy |
| Settings | `STORAGE_DIR` | `S3_BUCKET`, `S3_PREFIX` (default `spendboard`), `S3_REGION`, `S3_ENDPOINT_URL` (MinIO, R2, …), credentials from the standard AWS chain (IAM role, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, profile) |

Why queries still use a local copy: DuckDB runs with external access disabled so user SQL can never reach the
filesystem or network — which also stops it reading S3 itself. Keys are **write-once** (a REST refresh writes a new
key and moves a pointer in Redis), so a cached copy can never be stale and workers need no coordination.

**Moving an existing install from local to S3**

1. Upgrade (migration `0004` rewrites any old absolute paths in `file_objects` to keys).
2. Copy the files: `aws s3 sync $STORAGE_DIR/uploads s3://BUCKET/PREFIX/uploads` and the same for `files`.
   (`rest/` is not needed — extracts are rebuilt on first use.)
3. Set `STORAGE_BACKEND=s3` and the `S3_*` settings on api, worker and scheduler; restart.

## 4b. The job queue: Celery and alternatives

Card queries are handed to workers in exactly one place, `backend/app/execution/queue.py` (`submit` on the
producer side, `handle` on the consumer side). Caching, single-flight locks and result delivery (Redis pub/sub)
don't depend on the queue. A job is a self-contained JSON payload and duplicates are harmless (they recompute the
same cache entry), so any at-least-once queue works.

| Option | Change needed | Verdict |
|---|---|---|
| Celery on Redis (default) | — | Right for this workload |
| Celery on **RabbitMQ** or **SQS** | `CELERY_BROKER_URL=amqp://…` or `sqs://…` (plus `pip install celery[sqs]`) | Easiest upgrade if you want a dedicated, durable broker |
| Redis Streams / SQS / Pub/Sub with a small asyncio consumer | New backend in `queue.py` + a consumer that calls `handle()` | Fewer moving parts than Celery; worth it only if Celery becomes a pain |
| **Kafka** | New backend + consumer | **Not recommended as the job queue** (see below) |

**Why not Kafka for the jobs.** These are short, interactive tasks: one dashboard view fans out ~10 queries that
must start within milliseconds, some take 50 ms and some take 30 s, and any free worker should pick up the next
one. That is a *work queue*. Kafka is a *log*: work is split by partition, a slow query blocks everything behind it
in its partition (head-of-line blocking), consumer counts are capped by partition count, there are no per-message
acks, retries or priorities, and rebalancing pauses consumption when workers scale. Kafka 4.x "share groups"
(queues for Kafka) narrow the gap but are new. It would also add a heavyweight cluster to operate.

**Where Kafka would make sense** is alongside the queue, as an event backbone: publishing `version.published`,
`change_request.merged`, `data_source.refreshed` or audit events for other systems (search indexing, notifications,
a data catalogue, cache invalidation from upstream data loads). That is additive and needs no change to execution.

## 4c. Health checks and alerts

Card queries run on workers, so a running API doesn't mean dashboards work: workers can be alive yet stuck (for
example, waiting on a data source that never answers), and then every uncached card fails. The system measures
*progress* — each worker records every task it finishes or discards — and compares it with the queue.

| Status | When |
|---|---|
| **failing** | Postgres or Redis unreachable; or **workers stuck**: no worker progress for `STUCK_AFTER_S` while card jobs wait in the queue, or while a card job has been held longer than that |
| **degraded** | More than `QUEUE_WARN_DEPTH` jobs queued, or a data source paused by its circuit breaker |
| **ok** | Anything else, including an idle system |

`STUCK_AFTER_S` defaults to the longest allowed query + 60 s, so a slow but healthy BigQuery job is never "stuck".

**Three checks, three jobs**

| Check | Use it as | Fails when |
|---|---|---|
| `GET /readyz` (api, port 8010) | **api readiness** probe | Postgres or Redis unreachable |
| `python -m app.ops.check` (worker container) | **worker liveness** probe — the platform restarts stuck workers | Workers stuck (exit code 1) |
| `GET /metrics` (api, Prometheus text) | Monitoring and alert rules | Never — exposes the numbers |

Stuck workers deliberately do **not** fail `/readyz`: that would take every API replica out of service and turn
"uncached cards fail" into "the whole app is down". `/healthz` stays a plain API liveness check. These endpoints
sit outside `/api`, so the web server never exposes them publicly; admins also get the full snapshot with reasons
at `GET /api/ops/health`.

Worker liveness probe (Kubernetes example — period and threshold are up to you; give it an initial delay so a
fresh worker can start):

```yaml
livenessProbe:
  exec: { command: ["python", "-m", "app.ops.check"] }
  initialDelaySeconds: 60
  periodSeconds: 60
  timeoutSeconds: 15
  failureThreshold: 2
```

The check is cluster-wide: if card jobs wait and *no* worker anywhere progresses, every worker is stuck, so
restarting them all is right. A restarted worker reports healthy at once, even while the broker still lists the
jobs its predecessor held (they are released after the visibility timeout, `QUERY_TIMEOUT_S` + 120 s).

**Metrics** (all read from Redis, so every API replica reports the same values):

| Metric | Meaning |
|---|---|
| `spendboard_status` | 0 ok · 1 degraded · 2 failing |
| `spendboard_up{component}` | Postgres / Redis reachable |
| `spendboard_workers_stuck` | 1 when workers are stuck |
| `spendboard_queue_depth{queue}` | Jobs waiting (`interactive`, `refresh`); absent when the broker isn't Redis — use the broker's own metrics |
| `spendboard_jobs_in_flight`, `spendboard_oldest_card_job_held_seconds` | Jobs taken by workers; age of the oldest card job |
| `spendboard_seconds_since_worker_activity` | Time since any worker last finished or discarded a task |
| `spendboard_breakers_open` | Data sources paused by the circuit breaker |
| `spendboard_card_lookups_total{result}`, `spendboard_card_jobs_total{outcome}`, `spendboard_compute_seconds{quantile}` | Cache hits, computations, errors, latency |

Suggested alerts: `spendboard_status == 2` for 2 minutes (page someone); `spendboard_status == 1` for 10 minutes
(investigate); `spendboard_breakers_open > 0` for 10 minutes (a data source is down).

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
| api | backend | `uvicorn app.main:app --host 0.0.0.0 --port 8010 --workers 2` | 2+ | liveness GET `/healthz`, readiness GET `/readyz` |
| worker | backend | `celery -A app.worker.celery_app worker -Q interactive,refresh -c 8` | 1+ | liveness exec `python -m app.ops.check` ([§4c](#4c-health-checks-and-alerts)) |
| scheduler | backend | `celery -A app.worker.celery_app beat --schedule /tmp/celerybeat-schedule` | **1** | process liveness |
| migrate (Job) | backend | `alembic upgrade head` | run once per release, before api | — |

- With `STORAGE_BACKEND=local`, mount the same `STORAGE_DIR` volume (ReadWriteMany) into api and worker pods.
  With `STORAGE_BACKEND=s3`, give each pod an `emptyDir` (or local SSD) at `STORAGE_DIR` and an IAM role / service
  account with `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on the bucket prefix — no shared volume needed.
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
    proxy_read_timeout 330s;      # longest source timeout (300 s) + queueing
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
- [ ] **File storage**: either a shared `STORAGE_DIR` mounted on api and all workers and backed up, or
  `STORAGE_BACKEND=s3` with bucket versioning/backups and a lifecycle rule only on `…/rest/` (old extracts).
- [ ] **Postgres**: backups of the `spendboard` database (versions, credentials, audit log live there). Size
  `max_connections` for (api processes + worker processes) × (`DB_POOL_SIZE` + `DB_MAX_OVERFLOW`).
- [ ] **Redis**: losing it only loses cached results and queued jobs (they are recomputed). For large caches set
  `maxmemory` with `volatile-lru` (cache entries have TTLs; locks and queue keys should not be evicted first), or run
  the broker and the cache on separate Redis instances.
- [ ] **Data-source accounts**: read-only database roles; BigQuery service accounts with only *BigQuery Data Viewer* +
  *BigQuery Job User*; sensible scan caps per BigQuery source.
- [ ] **TLS** at the edge; only the web server exposed.
- [ ] **Health**: api readiness on `/readyz`, worker liveness on `python -m app.ops.check`, `/metrics` scraped
  with an alert on `spendboard_status == 2` ([§4c](#4c-health-checks-and-alerts)).
- [ ] **Logs**: collect stdout/stderr of all four processes.
- [ ] **Sizing**: start with 2 API replicas × 2 Uvicorn workers and 1–2 worker containers × 8 processes; see
  [loadtest.md](loadtest.md) for measured throughput and how to re-run the load test against your install.

---

## 8. Check the install

```bash
curl -s http://<web-host>:3001/auth/users          # web server up (simulated sign-in)
curl -s http://<api-host>:8010/healthz              # {"status":"ok"}
curl -s http://<api-host>:8010/readyz               # {"status":"ready","postgres":true,"redis":true}
python -m app.ops.check --verbose                   # in a worker container: status, queue, worker progress
```

Then sign in, open a dashboard and confirm cards load (that exercises Redis, a worker and a data source end to end).

To run the backend test suite on a machine with the source tree (needs Postgres and Redis reachable as configured
in `backend/tests/conftest.py`):

```bash
cd backend && uv sync && uv run pytest
```
