-- Permissionless Telegram access for signal providers. One row per identity (voter) address, which is
-- the sybil unit: a voter belongs to one operator, and an operator on both chains should get one seat.
CREATE TABLE "TelegramAccess" (
  "id"               TEXT NOT NULL,
  "voter"            TEXT NOT NULL,
  "network"          TEXT NOT NULL,
  "token"            TEXT NOT NULL,
  "inviteLink"       TEXT,
  "state"            TEXT NOT NULL DEFAULT 'issued',
  "telegramUserId"   TEXT,
  "telegramUsername" TEXT,
  "issuedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "joinedAt"         TIMESTAMP(3),
  "ineligibleSince"  TIMESTAMP(3),
  "removedAt"        TIMESTAMP(3),
  CONSTRAINT "TelegramAccess_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramAccess_voter_key" ON "TelegramAccess"("voter");
CREATE UNIQUE INDEX "TelegramAccess_token_key" ON "TelegramAccess"("token");
CREATE INDEX "TelegramAccess_state_idx" ON "TelegramAccess"("state");
CREATE INDEX "TelegramAccess_ineligibleSince_idx" ON "TelegramAccess"("ineligibleSince");
