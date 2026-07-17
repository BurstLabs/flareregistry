-- ProviderWatch: a self-service, per-provider email watch. Anyone can ask to be emailed if a NEW
-- provider is flagged, while it is in its review window. Rows exist only while the provider is under
-- review; when it lists/qualifies (or is denied) every watch for it is deleted (email shredded).
-- Double opt-in: created unconfirmed with a token; the confirm link flips confirmed true.
CREATE TABLE "ProviderWatch" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "ProviderWatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderWatch_token_key" ON "ProviderWatch"("token");
CREATE INDEX "ProviderWatch_providerId_idx" ON "ProviderWatch"("providerId");
CREATE UNIQUE INDEX "ProviderWatch_providerId_email_key" ON "ProviderWatch"("providerId", "email");

ALTER TABLE "ProviderWatch" ADD CONSTRAINT "ProviderWatch_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
