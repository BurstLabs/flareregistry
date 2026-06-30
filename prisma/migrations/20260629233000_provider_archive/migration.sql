-- Soft-delete (archive) for departed providers instead of hard-delete. Archived providers are
-- excluded from the live feed but kept for the audit record and can be auto-unarchived on return.
ALTER TABLE "Provider" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Provider" ADD COLUMN "archivedReason" TEXT;
CREATE INDEX "Provider_archivedAt_idx" ON "Provider"("archivedAt");
