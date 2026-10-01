"""Metadata schema — see docs/architecture.md §4.

Cards, dashboards and data sources share one versioning model: an `Asset` is the stable identity
(owner, scope, lineage) and each save appends an immutable `AssetVersion` holding the typed spec.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

KINDS = ("data_source", "card", "dashboard")
SCOPES = ("private", "global")
ROLES = ("user", "admin")
SHARE_PERMISSIONS = ("view", "edit")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint(_in("role", ROLES), name="ck_users_role"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    sub: Mapped[str] = mapped_column(String(255), unique=True)
    email: Mapped[str] = mapped_column(String(320))
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(16), default="user")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (
        CheckConstraint(_in("kind", KINDS), name="ck_assets_kind"),
        CheckConstraint(_in("scope", SCOPES), name="ck_assets_scope"),
        # Private assets always have an owner; global assets are org-owned
        CheckConstraint("scope = 'global' OR owner_id IS NOT NULL", name="ck_assets_private_owner"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    scope: Mapped[str] = mapped_column(String(16), index=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    # Denormalised from the head version for cheap listing
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    head_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("asset_versions.id", use_alter=True, name="fk_assets_head_version"))
    forked_from_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"))
    forked_from_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("asset_versions.id", use_alter=True, name="fk_assets_forked_from_version"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AssetVersion(Base):
    """Immutable — a database trigger rejects UPDATE and DELETE."""

    __tablename__ = "asset_versions"
    __table_args__ = (UniqueConstraint("asset_id", "version_no", name="uq_asset_versions_no"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB)
    spec_schema: Mapped[int] = mapped_column(Integer, default=1)
    change_note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AssetDependency(Base):
    """card version → data-source version; dashboard version → card versions."""

    __tablename__ = "asset_dependencies"

    version_id: Mapped[int] = mapped_column(ForeignKey("asset_versions.id"), primary_key=True)
    depends_on_version_id: Mapped[int] = mapped_column(ForeignKey("asset_versions.id"), primary_key=True, index=True)
    depends_on_asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"), index=True)


class AssetShare(Base):
    __tablename__ = "asset_shares"
    __table_args__ = (
        CheckConstraint("grantee_type IN ('user')", name="ck_asset_shares_grantee_type"),
        CheckConstraint(_in("permission", SHARE_PERMISSIONS), name="ck_asset_shares_permission"),
    )

    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"), primary_key=True)
    grantee_type: Mapped[str] = mapped_column(String(16), primary_key=True, default="user")
    grantee_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    permission: Mapped[str] = mapped_column(String(16))
    granted_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ChangeRequest(Base):
    __tablename__ = "change_requests"
    __table_args__ = (
        CheckConstraint(_in("status", ("pending", "approved", "rejected", "withdrawn")), name="ck_change_requests_status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    requested_by: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # The asset the user submitted; the other items are its private dependencies (bundle)
    root_asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"), index=True)
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    review_comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ChangeRequestItem(Base):
    __tablename__ = "change_request_items"
    __table_args__ = (
        CheckConstraint(_in("type", ("publish_new", "update_existing")), name="ck_change_request_items_type"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("change_requests.id"), index=True)
    # Dependency order within the bundle: data sources, then cards, then dashboards
    position: Mapped[int] = mapped_column(Integer, default=0)
    type: Mapped[str] = mapped_column(String(24))
    source_asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"))
    source_version_id: Mapped[int] = mapped_column(ForeignKey("asset_versions.id"))
    target_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"))
    base_version_id: Mapped[int | None] = mapped_column(ForeignKey("asset_versions.id"))
    result_version_id: Mapped[int | None] = mapped_column(ForeignKey("asset_versions.id"))


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(64))
    asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"), index=True)
    version_id: Mapped[int | None] = mapped_column(ForeignKey("asset_versions.id"))
    request_id: Mapped[int | None] = mapped_column(ForeignKey("change_requests.id"))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
