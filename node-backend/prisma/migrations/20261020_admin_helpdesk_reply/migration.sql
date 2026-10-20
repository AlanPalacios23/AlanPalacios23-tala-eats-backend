-- ADMIN helpdesk and reply history for Tala Eats Customer support.
-- Staging PostgreSQL 15 only, after reviewed backup/restore.
ALTER TABLE "support_tickets"
  ADD COLUMN "admin_reply" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "responded_at" TIMESTAMP(3);
