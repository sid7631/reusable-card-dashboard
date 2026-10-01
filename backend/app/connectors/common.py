import asyncio
import ipaddress
import socket
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from app.core.config import get_settings


class QueryError(Exception):
    """A query or connection failed at the source — reported to the user as a 400."""


def jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).hex()
    return value


async def check_public_host(host: str, *, is_admin: bool) -> None:
    """SSRF guard: analysts may not point sources at loopback/private/link-local addresses
    (metadata services, the platform's own databases) unless the deployment allows it.

    Checked when a source is saved or tested; connection-time pinning (DNS rebinding) is a known gap.
    """
    if is_admin or get_settings().allow_private_network_sources:
        return
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise QueryError(f"Cannot resolve host “{host}”.") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise QueryError(f"“{host}” resolves to a private network address, which isn't allowed for data sources.")
