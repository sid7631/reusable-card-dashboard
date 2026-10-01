"""Test harness: migrated `spendboard_test` database, seeded demo warehouse, and an in-process
identity provider (RSA key + JWKS) so tests mint real signed tokens."""

import os
import subprocess
import time
import uuid

os.environ["ALLOW_PRIVATE_NETWORK_SOURCES"] = "true"   # tests that check the SSRF guard switch it off
os.environ["STORAGE_DIR"] = os.environ.get("TEST_STORAGE_DIR", "/tmp/spendboard-test-storage")
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://postgres:postgres@localhost:5433/spendboard_test")

import jwt  # noqa: E402
import pytest  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core import auth  # noqa: E402
from app.core.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402

PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KID = "test-key"


class StaticJwks:
    async def get(self, kid: str):
        if kid != KID:
            raise KeyError(kid)
        return PRIVATE_KEY.public_key()


def make_token(sub: str, *, role: str = "user", name: str | None = None, exp_in: int = 3600, key=PRIVATE_KEY) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "name": name or sub, "email": f"{sub}@test", "roles": [role],
         "iss": "spendboard-auth", "aud": "spendboard-api", "iat": now, "exp": now + exp_in},
        key, algorithm="RS256", headers={"kid": KID},
    )


@pytest.fixture(scope="session", autouse=True)
async def database():
    import shutil
    shutil.rmtree(os.environ["STORAGE_DIR"], ignore_errors=True)   # extracts from earlier runs
    env = {**os.environ, "ALEMBIC_DATABASE_URL": os.environ["DATABASE_URL"]}
    subprocess.run(["alembic", "downgrade", "base"], check=True, env=env, capture_output=True)
    subprocess.run(["alembic", "upgrade", "head"], check=True, env=env, capture_output=True)
    from app.seed.__main__ import seed_assets, seed_warehouse
    await seed_warehouse(reset=False)
    await seed_assets(reset=False)
    auth.jwks = StaticJwks()
    yield
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


class Actor:
    """An authenticated test user — each test gets fresh, unique users."""

    def __init__(self, client: AsyncClient, role: str = "user"):
        self.sub = f"{role}-{uuid.uuid4().hex[:8]}"
        self.client = client
        self.headers = {"Authorization": f"Bearer {make_token(self.sub, role=role)}"}

    async def get(self, url, **kw):
        return await self.client.get(url, headers=self.headers, **kw)

    async def post(self, url, json=None):
        return await self.client.post(url, headers=self.headers, json=json)

    async def upload(self, url, filename: str, content: bytes):
        return await self.client.post(url, headers=self.headers, files={"file": (filename, content)})

    async def put(self, url, json=None):
        return await self.client.put(url, headers=self.headers, json=json)

    async def delete(self, url):
        return await self.client.delete(url, headers=self.headers)


@pytest.fixture
def user(client):
    return Actor(client)


@pytest.fixture
def other_user(client):
    return Actor(client)


@pytest.fixture
def admin(client):
    return Actor(client, role="admin")


@pytest.fixture
async def seeded(user):
    """Ids of the seeded global data source, cards and dashboard."""
    sources = (await user.get("/api/data-sources")).json()
    dashboards = (await user.get("/api/dashboards?scope=global")).json()
    cards = (await user.get("/api/cards?scope=global")).json()
    return {"source_id": sources[0]["id"], "dashboard_id": dashboards[0]["id"],
            "cards": {c["name"]: c for c in cards}}


async def run_sql(sql: str):
    async with SessionLocal() as session:
        return await session.execute(text(sql))
