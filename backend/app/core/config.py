from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5433/spendboard"
    # Per process. API processes × (pool + overflow) must stay under Postgres max_connections.
    db_pool_size: int = 5
    db_max_overflow: int = 10
    redis_url: str = "redis://localhost:6380/0"

    # Simulated SSO: the web deployment's auth service signs RS256 tokens and publishes its JWKS
    jwks_url: str = "http://localhost:3001/auth/.well-known/jwks.json"
    jwt_issuer: str = "spendboard-auth"
    jwt_audience: str = "spendboard-api"

    # Demo warehouse — owner connection is used only for seeding; cards query it as warehouse_reader
    warehouse_admin_url: str = "postgresql://postgres:postgres@localhost:5433/demo_warehouse"
    demo_warehouse_host: str = "localhost"
    demo_warehouse_port: int = 5433
    demo_warehouse_password: str = "reader"

    query_max_rows: int = 1000
    query_timeout_s: float = 30.0

    # Fernet key for data-source credentials. The default is for local development only —
    # set SECRET_KEY in every shared environment (generate with cryptography.fernet.Fernet.generate_key()).
    secret_key: str = "spendboard-dev-only-key-change-me-in-any-shared-env="
    # Uploaded files and DuckDB extracts (see app/core/storage.py).
    #   local : files under STORAGE_DIR — every API and worker process must share this directory
    #   s3    : objects in S3_BUCKET (or any S3-compatible store); STORAGE_DIR is then only a local
    #           per-process cache and scratch space. Credentials come from the standard AWS chain.
    storage_backend: str = "local"
    storage_dir: str = "storage"
    s3_bucket: str = ""
    s3_prefix: str = "spendboard"
    s3_endpoint_url: str | None = None   # MinIO, Cloudflare R2, a test emulator…
    s3_region: str | None = None
    # S3 only: per-process cache of downloaded files; least-recently-used files are evicted beyond this
    storage_cache_max_mb: int = 5000
    max_upload_mb: int = 50
    # Whether non-admins may point sources at private/loopback addresses (SSRF guard). On for local dev.
    allow_private_network_sources: bool = False
    # Development/tests only: send every BigQuery source to an emulator (e.g. http://localhost:9050)
    bigquery_emulator_host: str | None = None
    rest_max_records: int = 100_000
    rest_max_response_mb: int = 20

    # Execution: "celery" runs card queries on workers; "inline" runs them in the API process
    # (tests, single-process demos). Caching and single-flight behave the same either way.
    execution_mode: str = "celery"
    # Celery's broker. Defaults to REDIS_URL; point it at RabbitMQ (amqp://…) or SQS (sqs://…) to move
    # the job queue off Redis without touching the cache.
    celery_broker_url: str | None = None
    # Cached results are served past their TTL (marked stale, refreshed in the background) for this long
    stale_grace_s: int = 6 * 3600
    # How long a request waits for a result being computed elsewhere
    result_wait_s: float = 60
    # Circuit breaker per source endpoint: this many failures within a minute opens it for `breaker_open_s`
    breaker_failures: int = 5
    breaker_open_s: int = 30

    # Dashboard assistant — OpenAI chat-completions format.
    #   offline : no model calls; answers from the figures on screen (rule-based)
    #   openai  : any OpenAI-compatible endpoint — OpenAI, or Ollama at http://localhost:11434/v1
    #   azure   : Azure OpenAI (LLM_MODEL is the deployment name)
    llm_provider: str = "offline"
    llm_model: str = ""
    llm_base_url: str | None = None
    llm_api_key: str = ""
    azure_openai_endpoint: str = ""
    azure_openai_api_version: str = "2024-10-21"
    llm_temperature: float = 0.1
    llm_timeout_s: float = 60
    llm_max_tool_rounds: int = 6
    assistant_requests_per_minute: int = 20


@lru_cache
def get_settings() -> Settings:
    return Settings()
