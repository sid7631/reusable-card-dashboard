"""major.minor version labels

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-12 10:00:00.000000

`version_no` stays the gapless per-asset sequence (history URLs, ordering). `major`/`minor` are the
version people see: global versions are N (minor 0); a private copy of global vN saves N.1, N.2, …;
a private asset that was never published saves 0.1, 0.2, … Publishing makes the next major.

Existing rows are backfilled once (the immutability trigger is paused for it): global versions get
major = version_no; private copies are numbered after the global version they currently track;
other private assets get 0.<version_no>.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('asset_versions', sa.Column('major', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('asset_versions', sa.Column('minor', sa.Integer(), nullable=False, server_default='0'))
    op.execute("ALTER TABLE asset_versions DISABLE TRIGGER asset_versions_immutable")
    op.execute("""
        UPDATE asset_versions v SET major = v.version_no, minor = 0
        FROM assets a WHERE a.id = v.asset_id AND a.scope = 'global'
    """)
    op.execute("""
        UPDATE asset_versions v SET major = COALESCE(base.version_no, 0), minor = v.version_no
        FROM assets a LEFT JOIN asset_versions base ON base.id = a.forked_from_version_id
        WHERE a.id = v.asset_id AND a.scope = 'private'
    """)
    op.execute("ALTER TABLE asset_versions ENABLE TRIGGER asset_versions_immutable")
    op.create_unique_constraint('uq_asset_versions_label', 'asset_versions', ['asset_id', 'major', 'minor'])


def downgrade() -> None:
    op.drop_constraint('uq_asset_versions_label', 'asset_versions', type_='unique')
    op.drop_column('asset_versions', 'minor')
    op.drop_column('asset_versions', 'major')
