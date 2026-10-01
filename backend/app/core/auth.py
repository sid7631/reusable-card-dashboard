"""Bearer-token authentication against the (simulated) SSO provider's JWKS.

Tokens are RS256 JWTs issued by the web deployment's auth service. Swapping in a real IdP
(Okta, Azure AD, ...) only changes JWKS_URL / issuer / audience and the claim mapping below.
"""

import time
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_session
from app.models import User


class JwksCache:
    """Caches signing keys by kid; refetches when an unknown kid appears (key rotation)."""

    def __init__(self, url: str, ttl_s: float = 600):
        self.url = url
        self.ttl_s = ttl_s
        self._keys: dict[str, Any] = {}
        self._fetched_at = 0.0

    async def _refresh(self) -> None:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(self.url)
            res.raise_for_status()
        self._keys = {k["kid"]: jwt.PyJWK(k).key for k in res.json()["keys"]}
        self._fetched_at = time.monotonic()

    async def get(self, kid: str) -> Any:
        if kid not in self._keys or time.monotonic() - self._fetched_at > self.ttl_s:
            await self._refresh()
        if kid not in self._keys:
            raise KeyError(kid)
        return self._keys[kid]


jwks = JwksCache(get_settings().jwks_url)
bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": "Bearer"})


async def verify_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        kid = jwt.get_unverified_header(token).get("kid", "")
        key = await jwks.get(kid)
        return jwt.decode(
            token, key, algorithms=["RS256"], audience=settings.jwt_audience, issuer=settings.jwt_issuer,
            options={"require": ["exp", "sub", "iss", "aud"]},
        )
    except (jwt.PyJWTError, KeyError) as exc:
        raise _unauthorized("Invalid or expired token.") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Identity provider unavailable.") from exc


async def current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    if creds is None:
        raise _unauthorized("Missing bearer token.")
    claims = await verify_token(creds.credentials)
    role = "admin" if "admin" in claims.get("roles", []) else "user"

    # Just-in-time provisioning, as with a real SSO login
    user = await session.scalar(select(User).where(User.sub == claims["sub"]))
    if user is None:
        user = User(sub=claims["sub"], email=claims.get("email", ""), name=claims.get("name", claims["sub"]), role=role)
        session.add(user)
        await session.commit()
    elif (user.role, user.email, user.name) != (role, claims.get("email", user.email), claims.get("name", user.name)):
        user.role, user.email, user.name = role, claims.get("email", user.email), claims.get("name", user.name)
        await session.commit()
    return user


CurrentUser = Annotated[User, Depends(current_user)]
Session = Annotated[AsyncSession, Depends(get_session)]
