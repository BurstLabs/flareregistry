-- Direct pairwise submission-agreement measurement, kept separate from the inference-based
-- ProviderSimilarity because one is publishable and the other is not.
CREATE TABLE IF NOT EXISTS "SubmissionAgreement" (
  "id"         TEXT NOT NULL,
  "network"    TEXT NOT NULL,
  "addrA"      TEXT NOT NULL,
  "addrB"      TEXT NOT NULL,
  "agreeCells" INTEGER NOT NULL,
  "totalCells" INTEGER NOT NULL,
  "fromRound"  INTEGER NOT NULL,
  "toRound"    INTEGER NOT NULL,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubmissionAgreement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SubmissionAgreement_network_addrA_addrB_key"
  ON "SubmissionAgreement"("network","addrA","addrB");
CREATE INDEX IF NOT EXISTS "SubmissionAgreement_network_toRound_idx" ON "SubmissionAgreement"("network","toRound");
CREATE INDEX IF NOT EXISTS "SubmissionAgreement_network_addrA_idx"   ON "SubmissionAgreement"("network","addrA");
CREATE INDEX IF NOT EXISTS "SubmissionAgreement_network_addrB_idx"   ON "SubmissionAgreement"("network","addrB");

CREATE TABLE IF NOT EXISTS "CorrelationSnapshot" (
  "id"         TEXT NOT NULL,
  "network"    TEXT NOT NULL,
  "voter"      TEXT NOT NULL,
  "maxRate"    DOUBLE PRECISION NOT NULL,
  "meanRate"   DOUBLE PRECISION NOT NULL,
  "peersAbove" INTEGER NOT NULL,
  "peers"      INTEGER NOT NULL,
  "fromRound"  INTEGER NOT NULL,
  "toRound"    INTEGER NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CorrelationSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CorrelationSnapshot_network_voter_createdAt_idx" ON "CorrelationSnapshot"("network","voter","createdAt");
CREATE INDEX IF NOT EXISTS "CorrelationSnapshot_network_createdAt_idx"       ON "CorrelationSnapshot"("network","createdAt");
