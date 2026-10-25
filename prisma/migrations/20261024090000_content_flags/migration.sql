-- Reasons a provider description was flagged for human review (off-domain links, contact handles,
-- financial promises, manufactured urgency). The listing publishes either way; see lib/content-review.
ALTER TABLE "Provider" ADD COLUMN "contentFlags" JSONB;
ALTER TABLE "Provider" ADD COLUMN "contentFlaggedAt" TIMESTAMP(3);
