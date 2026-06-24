-- Add Management Group membership flag to on-chain entities.
ALTER TABLE "ProviderOnchain" ADD COLUMN "managementGroup" BOOLEAN NOT NULL DEFAULT false;
