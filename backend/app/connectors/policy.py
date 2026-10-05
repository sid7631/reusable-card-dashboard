"""Rules every data-source version must satisfy before it is saved (by any path: create, edit,
restore, update-from-global, approval)."""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors import rest
from app.connectors.common import QueryError, check_public_host
from app.core.secrets import secret_id
from app.governance.specs import DataSourceSpec
from app.models import Asset, AssetVersion, FileObject, Secret, User


async def _lineage_specs(session: AsyncSession, asset: Asset) -> list[DataSourceSpec]:
    """Specs the asset already legitimately holds: its head, the global version it was copied from,
    and that global asset's head."""
    ids = {asset.head_version_id, asset.forked_from_version_id}
    if asset.forked_from_asset_id:
        ids.add(await session.scalar(select(Asset.head_version_id).where(Asset.id == asset.forked_from_asset_id)))
    versions = await session.scalars(select(AssetVersion).where(AssetVersion.id.in_({i for i in ids if i})))
    return [DataSourceSpec.model_validate(v.spec) for v in versions]


def _deny(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, message)


async def check_data_source(session: AsyncSession, user: User, asset: Asset, spec: DataSourceSpec) -> None:
    lineage = await _lineage_specs(session, asset)

    def inherited(ref: str) -> bool:
        # Reusing a credential is fine only against the same endpoint it was saved for — otherwise a
        # copy could send someone else's password to a host of the editor's choosing
        return any(ref in s.secret_refs() and s.endpoint() == spec.endpoint() for s in lineage)

    for ref in spec.secret_refs():
        if ref.startswith("env:"):
            if user.role != "admin" and not inherited(ref):
                raise _deny("Only admins can reference server settings (env:) — enter credentials instead.")
        elif (sid := secret_id(ref)) is not None:
            secret = await session.get(Secret, sid)
            if secret is None:
                raise _deny("Unknown stored credential.")
            if secret.owner_id != user.id and not inherited(ref):
                raise _deny("Re-enter the credentials when changing where this source connects.")
        else:
            raise _deny("Credentials must be stored secrets, not plain text.")

    endpoint_fields = [spec.connection.host, str(spec.connection.port), spec.connection.database,
                       spec.connection.user] if spec.connection else []
    if user.role != "admin" and any(str(v).startswith("env:") for v in endpoint_fields) and not any(
            s.endpoint() == spec.endpoint() for s in lineage):
        raise _deny("Only admins can reference server settings (env:).")

    if spec.bigquery and spec.bigquery.auth == "adc" and user.role != "admin" and not any(
            s.endpoint() == spec.endpoint() for s in lineage):
        # The server's own Google identity can reach whatever the deployment's service account can
        raise _deny("Only admins can use the server's own Google identity — upload a service-account key.")

    if spec.file:
        file = await session.get(FileObject, spec.file.file_id)
        if file is None:
            raise _deny("Uploaded file not found.")
        if file.uploaded_by != user.id and not any(s.file and s.file.file_id == file.id for s in lineage):
            raise _deny("You can only build sources from files you uploaded.")

    host = spec.connection.host if spec.connection else rest.host_of(spec) if spec.rest else None
    if host and not host.startswith("env:") and not any(s.endpoint() == spec.endpoint() for s in lineage):
        try:
            await check_public_host(host, is_admin=user.role == "admin")
        except QueryError as exc:
            raise _deny(str(exc)) from exc
