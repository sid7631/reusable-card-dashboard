"""Storage backends behave the same; uploads and REST extracts run end to end on S3 (moto emulator)."""

import boto3
import pytest
from moto.server import ThreadedMotoServer

from app.core import storage
from app.core.config import get_settings
from app.core.storage import LocalStorage, S3Storage, StorageError
from tests.test_data_sources import CSV, fake_api, rest_spec, upload_source  # noqa: F401  (fixture)

BUCKET = "spendboard-test"


@pytest.fixture(scope="module")
def s3_endpoint():
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1", aws_access_key_id="test",
                 aws_secret_access_key="test").create_bucket(Bucket=BUCKET)
    yield endpoint
    server.stop()


@pytest.fixture
def s3_env(monkeypatch, s3_endpoint):
    for name, value in {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test", "AWS_DEFAULT_REGION": "us-east-1"}.items():
        monkeypatch.setenv(name, value)
    return s3_endpoint


@pytest.fixture
def s3_backend(monkeypatch, s3_env):
    """Switch the whole app to S3 for one test."""
    settings = get_settings()
    for name, value in {"storage_backend": "s3", "s3_bucket": BUCKET, "s3_prefix": "app", "s3_endpoint_url": s3_env}.items():
        monkeypatch.setattr(settings, name, value)
    storage.get_storage.cache_clear()
    yield storage.get_storage()
    storage.get_storage.cache_clear()


@pytest.fixture(params=["local", "s3"])
def backend(request, tmp_path, s3_env):
    if request.param == "local":
        return LocalStorage(tmp_path / "root")
    return S3Storage(BUCKET, "unit", tmp_path / "cache", endpoint_url=s3_env, region="us-east-1")


def test_round_trip(backend, tmp_path):
    src = tmp_path / "src.bin"
    src.write_bytes(b"hello")
    backend.put_file("a/b.bin", src)
    assert backend.exists("a/b.bin")
    assert backend.local_path("a/b.bin").read_bytes() == b"hello"
    backend.delete("a/b.bin")
    assert not backend.exists("a/b.bin")
    with pytest.raises(StorageError):
        backend.local_path("a/b.bin")


@pytest.mark.parametrize("key", ["", "/etc/passwd", "../x", "a/../../x"])
def test_keys_cannot_escape(backend, key):
    with pytest.raises(StorageError):
        backend.exists(key)


def test_s3_reads_download_once_into_the_cache(tmp_path, s3_env):
    writer = S3Storage(BUCKET, "cache-test", tmp_path / "w", endpoint_url=s3_env, region="us-east-1")
    src = tmp_path / "f"
    src.write_bytes(b"x" * 10)
    writer.put_file("k.bin", src)
    # Another process (own cache) downloads it on first read, then serves the cached copy
    reader = S3Storage(BUCKET, "cache-test", tmp_path / "r", endpoint_url=s3_env, region="us-east-1")
    first = reader.local_path("k.bin")
    reader.client = None  # no further S3 calls possible
    assert reader.local_path("k.bin") == first and first.read_bytes() == b"x" * 10


def test_s3_cache_evicts_least_recently_used(tmp_path, s3_env):
    store = S3Storage(BUCKET, "evict", tmp_path / "c", endpoint_url=s3_env, region="us-east-1", cache_max_bytes=25)
    for i in range(4):
        src = tmp_path / f"s{i}"
        src.write_bytes(b"y" * 10)
        store.put_file(f"{i}.bin", src)
    cached = sorted(p.name for p in (tmp_path / "c").rglob("*.bin"))
    assert cached == ["2.bin", "3.bin"]
    assert store.local_path("0.bin").read_bytes() == b"y" * 10  # evicted copies are fetched again


async def test_uploads_are_stored_in_s3_and_queryable(user, s3_backend):
    source = await upload_source(user)
    file_id = source["spec"]["file"]["file_id"]
    assert s3_backend.exists(f"files/{file_id}.duckdb") and s3_backend.exists(f"uploads/{file_id}.csv")
    keys = [o["Key"] for o in s3_backend.client.list_objects_v2(Bucket=BUCKET, Prefix="app/")["Contents"]]
    assert f"app/files/{file_id}.duckdb" in keys
    # A fresh cache (another worker) still answers queries
    s3_backend.cache_dir = s3_backend.cache_dir.with_name("other-worker")
    table = source["upload"]["tables"][0]["name"]
    res = await user.post("/api/query", {"sql": f'SELECT COUNT(*) AS n FROM "{table}"', "data_source_id": source["id"]})
    assert res.status_code == 200 and res.json()["rows"][0]["n"] > 0


async def test_rest_extracts_are_immutable_objects_behind_a_pointer(user, fake_api, s3_backend):  # noqa: F811
    source = (await user.post("/api/data-sources", {"name": "Scores S3", "spec": rest_spec()})).json()
    q = {"sql": "SELECT COUNT(*) AS n FROM scores", "data_source_id": source["id"]}
    assert (await user.post("/api/query", q)).json()["rows"] == [{"n": 5}]
    keys = [o["Key"] for o in s3_backend.client.list_objects_v2(Bucket=BUCKET, Prefix="app/rest/")["Contents"]]
    assert len(keys) == 1 and keys[0].endswith(".duckdb")
