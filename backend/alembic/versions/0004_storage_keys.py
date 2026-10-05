"""file objects store storage keys, not absolute paths

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-05 10:00:00.000000

Earlier uploads recorded paths like /app/storage/uploads/12.csv. Files stay where they are on disk;
only the column values change, to keys relative to STORAGE_DIR (uploads/12.csv, files/12.duckdb),
which LocalStorage resolves to the same files. To move to S3 afterwards, copy STORAGE_DIR's
uploads/ and files/ folders into the bucket under S3_PREFIX.
"""
from collections.abc import Sequence

from alembic import op

revision: str = '0004'
down_revision: str | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(r"""
        UPDATE file_objects SET
          storage_key = regexp_replace(storage_key, '^.*/(uploads/[^/]+)$', '\1'),
          db_key      = regexp_replace(db_key,      '^.*/(files/[^/]+)$',   '\1')
        WHERE storage_key LIKE '/%' OR db_key LIKE '/%'
    """)


def downgrade() -> None:
    pass  # keys still identify the files; older code would need STORAGE_DIR prepended by hand
