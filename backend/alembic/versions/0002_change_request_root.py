"""change request root asset and item order

Revision ID: 0002
Revises: 0001
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # No change requests exist before this revision, so the NOT NULL column needs no backfill
    op.add_column("change_requests", sa.Column("root_asset_id", sa.BigInteger(), nullable=False))
    op.create_foreign_key("fk_change_requests_root_asset", "change_requests", "assets", ["root_asset_id"], ["id"])
    op.create_index("ix_change_requests_root_asset_id", "change_requests", ["root_asset_id"])
    op.add_column("change_request_items", sa.Column("position", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("change_request_items", "position")
    op.drop_index("ix_change_requests_root_asset_id", table_name="change_requests")
    op.drop_constraint("fk_change_requests_root_asset", "change_requests", type_="foreignkey")
    op.drop_column("change_requests", "root_asset_id")
