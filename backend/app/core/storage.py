"""Where uploaded files and DuckDB extracts live.

Code stores and reads *keys* such as `uploads/12.csv` or `files/12.duckdb`, never filesystem paths, and
picks the backend from settings:

    STORAGE_BACKEND=local   files under STORAGE_DIR (one shared filesystem for the API and all workers)
    STORAGE_BACKEND=s3      objects in S3_BUCKET under S3_PREFIX; each process keeps a local cache copy

Keys are write-once: a new version of something is a new key, never an overwrite. That is what lets a
worker's cached copy of an S3 object stay valid forever without coordination.

DuckDB needs a local file to query (it runs with external access disabled, so it can't read S3 itself);
`local_path(key)` returns one — the file itself for local storage, a cached download for S3.
"""

import shutil
import threading
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.core.config import get_settings


class StorageError(Exception):
    pass


class Storage(Protocol):
    def put_file(self, key: str, source: Path) -> None: ...
    def local_path(self, key: str) -> Path: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...


def _check_key(key: str) -> str:
    if not key or key.startswith("/") or ".." in key.split("/"):
        raise StorageError(f"Invalid storage key: {key!r}")
    return key


def scratch_dir() -> Path:
    """Local working space for building files before they are stored (never shared between processes)."""
    path = Path(get_settings().storage_dir).resolve() / "tmp"
    path.mkdir(parents=True, exist_ok=True)
    return path


def scratch_path(suffix: str = "") -> Path:
    return scratch_dir() / f"{uuid.uuid4().hex}{suffix}"


class LocalStorage:
    """Keys map to files under a root directory that every process must share."""

    def __init__(self, root: Path):
        self.root = root

    def _path(self, key: str) -> Path:
        return self.root / _check_key(key)

    def put_file(self, key: str, source: Path) -> None:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex}")
        shutil.copyfile(source, tmp)
        tmp.replace(target)  # atomic: readers see the old file or the new one, never half of one

    def local_path(self, key: str) -> Path:
        path = self._path(key)
        if not path.exists():
            raise StorageError(f"Missing stored file {key}.")
        return path

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class S3Storage:
    """Objects in S3 (or any S3-compatible store); reads go through a per-process local cache."""

    def __init__(self, bucket: str, prefix: str, cache_dir: Path, *, endpoint_url: str | None, region: str | None,
                 cache_max_bytes: int = 5000 * 1024 * 1024):
        import boto3

        self.bucket, self.prefix, self.cache_dir = bucket, prefix.strip("/"), cache_dir
        self.cache_max_bytes = cache_max_bytes
        # Credentials come from the standard AWS chain: env vars, instance/pod role, profile
        self.client = boto3.client("s3", endpoint_url=endpoint_url, region_name=region)
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _object(self, key: str) -> str:
        key = _check_key(key)
        return f"{self.prefix}/{key}" if self.prefix else key

    def put_file(self, key: str, source: Path) -> None:
        self.client.upload_file(str(source), self.bucket, self._object(key))
        # The writer already has the bytes — seed its own cache so it doesn't download them again
        cached = self.cache_dir / key
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_name(f".{cached.name}.{uuid.uuid4().hex}")
        shutil.copyfile(source, tmp)
        tmp.replace(cached)
        self._prune(keep=cached)

    def local_path(self, key: str) -> Path:
        cached = self.cache_dir / _check_key(key)
        if cached.exists():
            cached.touch()  # recency for cache eviction
            return cached  # keys are write-once, so a cached copy is never stale
        with self._guard:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:  # one download per key per process
            if not cached.exists():
                from botocore.exceptions import ClientError
                cached.parent.mkdir(parents=True, exist_ok=True)
                tmp = cached.with_name(f".{cached.name}.{uuid.uuid4().hex}")
                try:
                    self.client.download_file(self.bucket, self._object(key), str(tmp))
                except ClientError as exc:
                    tmp.unlink(missing_ok=True)
                    raise StorageError(f"Missing stored file {key}.") from exc
                tmp.replace(cached)
                self._prune(keep=cached)
        return cached

    def _prune(self, keep: Path) -> None:
        """Evict least-recently-used cached files over the size cap. An evicted file that a query
        still has open stays readable (POSIX unlink); the next read downloads it again."""
        files = [(p.stat().st_mtime, p.stat().st_size, p) for p in self.cache_dir.rglob("*")
                 if p.is_file() and not p.name.startswith(".")]
        total = sum(size for _, size, _ in files)
        for _, size, path in sorted(files, key=lambda f: f[0]):
            if total <= self.cache_max_bytes:
                break
            if path != keep:
                path.unlink(missing_ok=True)
                total -= size

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._object(key))
            return True
        except ClientError:
            return False

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._object(key))
        (self.cache_dir / _check_key(key)).unlink(missing_ok=True)


@lru_cache
def get_storage() -> Storage:
    s = get_settings()
    root = Path(s.storage_dir).resolve()
    if s.storage_backend == "s3":
        if not s.s3_bucket:
            raise StorageError("STORAGE_BACKEND=s3 needs S3_BUCKET.")
        return S3Storage(s.s3_bucket, s.s3_prefix, root / "cache", endpoint_url=s.s3_endpoint_url, region=s.s3_region,
                         cache_max_bytes=s.storage_cache_max_mb * 1024 * 1024)
    if s.storage_backend != "local":
        raise StorageError(f"Unknown STORAGE_BACKEND “{s.storage_backend}”.")
    return LocalStorage(root)
