-- Management Group proposal alerts: opt-in email for new proposals, plus an optional
-- midpoint nudge. See the ProposalWatch / ProposalNotice models for the reasoning.

CREATE TABLE "ProposalWatch" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "halfway" BOOLEAN NOT NULL DEFAULT false,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "ProposalWatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProposalWatch_email_key" ON "ProposalWatch"("email");
CREATE UNIQUE INDEX "ProposalWatch_token_key" ON "ProposalWatch"("token");

CREATE TABLE "ProposalNotice" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "proposalKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProposalNotice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProposalNotice_watchId_proposalKey_kind_key"
    ON "ProposalNotice"("watchId", "proposalKey", "kind");
CREATE INDEX "ProposalNotice_proposalKey_idx" ON "ProposalNotice"("proposalKey");

ALTER TABLE "ProposalNotice" ADD CONSTRAINT "ProposalNotice_watchId_fkey"
    FOREIGN KEY ("watchId") REFERENCES "ProposalWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
