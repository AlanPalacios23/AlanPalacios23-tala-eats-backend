"""catalog media urls

Revision ID: f19g00000001
Revises: f18f00000001
"""
from alembic import op
import sqlalchemy as sa

revision = "f19g00000001"
down_revision = "f18f00000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("restaurants", sa.Column("cover_image_url", sa.String(length=600), nullable=False, server_default=""))
    op.add_column("menu_items", sa.Column("image_url", sa.String(length=600), nullable=False, server_default=""))


def downgrade():
    op.drop_column("menu_items", "image_url")
    op.drop_column("restaurants", "cover_image_url")
