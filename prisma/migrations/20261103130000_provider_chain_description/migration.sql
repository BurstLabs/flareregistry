-- Per-network description overrides.
--
-- Provider.description is one string published on every chain a provider is listed on, while the
-- upstream list we imported from stores one per chain. Whichever chain's copy we scanned was then
-- published on both, leaving 30 feed entries describing the wrong network: 7 Flare listings saying
-- "Songbird" and 23 Songbird listings saying "Flare". The text was never wrong, only mis-chained.
--
-- Keyed by (provider, chain), not by address: a provider may hold several addresses on one chain
-- and they all describe the same service there.
--
-- No row means "use Provider.description", which stays true for most providers.
CREATE TABLE "ProviderChainDescription" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderChainDescription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderChainDescription_providerId_chainId_key"
    ON "ProviderChainDescription"("providerId", "chainId");
CREATE INDEX "ProviderChainDescription_providerId_idx"
    ON "ProviderChainDescription"("providerId");

ALTER TABLE "ProviderChainDescription"
    ADD CONSTRAINT "ProviderChainDescription_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
