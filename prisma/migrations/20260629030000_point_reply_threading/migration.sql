-- Reply threading: a grounds entry (member) or defense entry (provider) may reply to another point.
-- replyToRef holds the target "<ownerType>:<ownerId>" ref; null = a top-level point.
ALTER TABLE "ProviderFlagGroundsEntry" ADD COLUMN "replyToRef" TEXT;
ALTER TABLE "ProviderFlagDefenseEntry" ADD COLUMN "replyToRef" TEXT;
CREATE INDEX "ProviderFlagGroundsEntry_replyToRef_idx" ON "ProviderFlagGroundsEntry"("replyToRef");
CREATE INDEX "ProviderFlagDefenseEntry_replyToRef_idx" ON "ProviderFlagDefenseEntry"("replyToRef");
