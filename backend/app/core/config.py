from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5433/spendboard"
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
