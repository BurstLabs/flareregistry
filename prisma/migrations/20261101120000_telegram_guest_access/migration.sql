-- Guest access to the providers' Telegram group, for people who belong in the room but will never
-- hold a provider address (Flare staff, for instance).
--
-- A guest is a separate KIND rather than a provider row with its checks disabled, so the on-chain
-- eligibility rule stays exactly as strict as it was and the exception is visible in the data. Guest
-- rows carry a synthetic "guest:<hex>" voter and "guest" network, because voter is unique and
-- required and nothing ever resolves a guest key on chain.
--
-- Existing rows are all provider rows, which is what the default records.
ALTER TABLE "TelegramAccess" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'provider';
ALTER TABLE "TelegramAccess" ADD COLUMN "label" TEXT;
