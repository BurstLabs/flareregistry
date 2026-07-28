CREATE TABLE "DetectionCursor" (
    "id" TEXT NOT NULL,
    "lastRound" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DetectionCursor_pkey" PRIMARY KEY ("id")
);
