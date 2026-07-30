-- Tick-grid (value lattice) evidence. Cumulative, not EW: the null is exact (1/T) and stationary, so
-- statistical power grows with every round rather than decaying out of a rolling window.
ALTER TABLE "ProviderSimilarity" ADD COLUMN "latticeHits" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "latticeExpected" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "latticeVar" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "latticeTrials" INTEGER NOT NULL DEFAULT 0;

-- Price tick per (feed, exchange, symbol), from ccxt market metadata. Refreshed daily by
-- scripts/collect-exchange-ticks.mjs. The RAW tick is stored, not the derived lattice T, because
-- T = tick * 10^decimals and `decimals` changes per reward epoch.
CREATE TABLE "FeedSourceTick" (
    "id" TEXT NOT NULL,
    "feedName" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "tick" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedSourceTick_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedSourceTick_feedName_exchange_symbol_key" ON "FeedSourceTick"("feedName", "exchange", "symbol");
CREATE INDEX "FeedSourceTick_feedName_idx" ON "FeedSourceTick"("feedName");
