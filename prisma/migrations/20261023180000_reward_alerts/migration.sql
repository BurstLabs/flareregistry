-- Opt-in to be told when a reward epoch is waiting for provider signatures. Separate from the
-- proposal alerts and off by default: it is an operator concern, not a delegator one.
ALTER TABLE "ProposalWatch" ADD COLUMN "rewards" BOOLEAN NOT NULL DEFAULT false;
