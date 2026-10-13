"""change request conversations and "changes requested"

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-12 16:00:00.000000

- `change_request_comments`: the conversation on a request. Besides plain comments it records the
  review steps (changes requested, sent back, approved, rejected, withdrawn) so the page reads as
  one timeline. Decisions made before this migration are copied in from `review_comment`.
- `change_request_reads`: when each person last opened a request — drives unread counts.
- status `changes_requested`: still open, waiting for the requester (the column is widened for it).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0006'
down_revision: str | None = '0005'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = "status IN ('pending', 'approved', 'rejected', 'withdrawn')"
NEW = "status IN ('pending', 'changes_requested', 'approved', 'rejected', 'withdrawn')"


def upgrade() -> None:
    op.alter_column('change_requests', 'status', type_=sa.String(24))
    op.drop_constraint('ck_change_requests_status', 'change_requests', type_='check')
    op.create_check_constraint('ck_change_requests_status', 'change_requests', NEW)

    op.create_table(
        'change_request_comments',
        sa.Column('id', sa.BigInteger(), primary_key=True),
        sa.Column('request_id', sa.BigInteger(), sa.ForeignKey('change_requests.id'), nullable=False, index=True),
        sa.Column('author_id', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('kind', sa.String(24), nullable=False),
        sa.Column('body', sa.Text(), nullable=False, server_default=''),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('comment', 'changes_requested', 'resubmitted', 'approved', 'rejected', 'withdrawn')",
                           name='ck_change_request_comments_kind'),
    )
    op.create_table(
        'change_request_reads',
        sa.Column('request_id', sa.BigInteger(), sa.ForeignKey('change_requests.id'), primary_key=True),
        sa.Column('user_id', sa.BigInteger(), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('last_read_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.execute("""
        INSERT INTO change_request_comments (request_id, author_id, kind, body, created_at)
        SELECT id, COALESCE(reviewed_by, requested_by), status, review_comment, COALESCE(decided_at, created_at)
        FROM change_requests WHERE status IN ('approved', 'rejected', 'withdrawn')
    """)


def downgrade() -> None:
    op.drop_table('change_request_reads')
    op.drop_table('change_request_comments')
    op.execute("UPDATE change_requests SET status = 'pending' WHERE status = 'changes_requested'")
    op.drop_constraint('ck_change_requests_status', 'change_requests', type_='check')
    op.create_check_constraint('ck_change_requests_status', 'change_requests', OLD)
    op.alter_column('change_requests', 'status', type_=sa.String(16))
