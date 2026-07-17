-- Self-declared "one registered entity per network" attestation (null = not declared).
-- Operator opts in on the submit form; not verifiable on-chain, shown labeled as self-declared.
ALTER TABLE "Provider" ADD COLUMN "singleEntity" BOOLEAN;
