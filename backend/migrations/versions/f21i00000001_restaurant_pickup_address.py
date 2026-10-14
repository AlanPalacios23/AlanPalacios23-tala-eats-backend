"""Add optional written address for merchant pickup location.

Revision ID: f21i00000001
Revises: f20h00000001

Existing lat/lng columns are reused without data rewriting. All existing
restaurants keep their coordinates and receive an empty written address.
"""
from alembic import op
import sqlalchemy as sa

revision = "f21i00000001"
down_revision = "f20h00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "restaurants",
        sa.Column("address", sa.String(length=300), nullable=False, server_default=""),
    )


def downgrade():
    # Data-loss prevention: do not silently drop merchant addresses.
    raise RuntimeError("Rollback de direcciones requiere aprobación y respaldo")
