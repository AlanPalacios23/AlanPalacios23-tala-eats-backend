"""Introduce 15/7/39/32 commercial policy defaults without touching historical orders.

Revision ID: f17e00000001
Revises: f16d00000001
"""
from alembic import op
import sqlalchemy as sa

revision = 'f17e00000001'
down_revision = 'f16d00000001'
branch_labels = None
depends_on = None

DEFAULTS = (
    ('commercial_v152.restaurant_commission_rate', '0.1500', 'Comisión sobre comida neta, excluye propina'),
    ('commercial_v152.service_fee_rate', '0.0700', 'Tarifa de servicio sobre comida neta en todos los métodos'),
    ('commercial_v152.base_delivery_fee', '39.00', 'Envío mínimo antes de descuentos existentes'),
    ('commercial_v152.base_driver_pay', '32.00', 'Pago base estimado al repartidor'),
)


def upgrade():
    bind = op.get_bind()
    for key, value, description in DEFAULTS:
        bind.execute(sa.text('''INSERT INTO system_settings (key, value, value_type, description, updated_at)
            VALUES (:key, :value, 'decimal', :description, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO NOTHING'''),
            {'key': key, 'value': value, 'description': description})


def downgrade():
    # Delete defaults only if still unchanged. Never delete an ADMIN-adjusted value.
    bind = op.get_bind()
    for key, value, _description in DEFAULTS:
        bind.execute(sa.text('DELETE FROM system_settings WHERE key = :key AND value = :value'),
                     {'key': key, 'value': value})
