"""Encrypted credentials for data sources.

Specs only ever hold a reference (`sec:<id>`); the plaintext is decrypted server-side when a
connector connects and is never returned by the API or written to a version.
"""

import base64
import hashlib
import os
import time

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.models import Secret, User


class SecretError(Exception):
    pass


def _fernet() -> Fernet:
    # Derive a valid Fernet key from any configured string, so SECRET_KEY can be a plain passphrase
    digest = hashlib.sha256(get_settings().secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


async def create_secret(session: AsyncSession, owner: User, plaintext: str) -> str:
    secret = Secret(owner_id=owner.id, ciphertext=_fernet().encrypt(plaintext.encode()).decode())
    session.add(secret)
    await session.flush()
    return f"sec:{secret.id}"


def secret_id(ref: str) -> int | None:
    return int(ref[4:]) if ref.startswith("sec:") and ref[4:].isdigit() else None


_cache: dict[int, tuple[float, str]] = {}
# Plaintext typed into a "test connection" form: resolvable for the duration of the test only
_transient: dict[str, str] = {}


def transient_ref(plaintext: str) -> str:
    import uuid
    ref = f"tmp:{uuid.uuid4().hex}"
    _transient[ref] = plaintext
    return ref


def drop_transient(ref: str | None) -> None:
    if ref:
        _transient.pop(ref, None)
_TTL_S = 60


async def resolve(value):
    """Resolve "env:NAME" and "sec:<id>" references; other values pass through."""
    if not isinstance(value, str):
        return value
    if value.startswith("env:"):
        name = value[4:]
        if name in os.environ:
            return os.environ[name]
        resolved = getattr(get_settings(), name.lower(), None)
        if resolved is None:
            raise SecretError(f"Setting {name} is not configured.")
        return resolved
    if value.startswith("tmp:"):
        if value not in _transient:
            raise SecretError("Test credential expired.")
        return _transient[value]
    sid = secret_id(value)
    if sid is None:
        return value
    hit = _cache.get(sid)
    if hit and time.monotonic() - hit[0] < _TTL_S:
        return hit[1]
    async with SessionLocal() as session:
        secret = await session.get(Secret, sid)
    if secret is None:
        raise SecretError("Stored credential not found.")
    try:
        plaintext = _fernet().decrypt(secret.ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise SecretError("Stored credential could not be decrypted (SECRET_KEY changed?).") from exc
    _cache[sid] = (time.monotonic(), plaintext)
    return plaintext
