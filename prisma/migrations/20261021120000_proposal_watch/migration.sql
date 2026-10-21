-- Management Group proposal alerts: opt-in email for new proposals, an optional midpoint
-- nudge, and a once-a-day operator warning when subscriber mail nears its daily cap.
-- See the ProposalWatch / ProposalNotice / MailQuotaWarning models for the reasoning.

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
    -- "sent" | "failed" | "skipped": what became of the claim. The row exists either way, because
    -- the row is what stops the job reconsidering this pairing forever.
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProposalNotice_pkey" PRIMARY KEY ("id")
);

-- The unique index IS the duplicate-send guard: two overlapping runs both try, one gets an error.
CREATE UNIQUE INDEX "ProposalNotice_watchId_proposalKey_kind_key"
    ON "ProposalNotice"("watchId", "proposalKey", "kind");
CREATE INDEX "ProposalNotice_proposalKey_idx" ON "ProposalNotice"("proposalKey");

ALTER TABLE "ProposalNotice" ADD CONSTRAINT "ProposalNotice_watchId_fkey"
    FOREIGN KEY ("watchId") REFERENCES "ProposalWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One operator warning per UTC day when subscriber mail nears or hits the daily cap.
CREATE TABLE "MailQuotaWarning" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "sent" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MailQuotaWarning_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MailQuotaWarning_day_key" ON "MailQuotaWarning"("day");
