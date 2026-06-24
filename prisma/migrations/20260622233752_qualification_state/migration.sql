-- CreateTable
CREATE TABLE "QualificationState" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "qualified" BOOLEAN NOT NULL DEFAULT false,
    "qualifiedAt" TIMESTAMP(3),
    "lastSubmittedEpoch" INTEGER,
    "lastEvaluatedEpoch" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualificationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QualificationState_network_voter_key" ON "QualificationState"("network", "voter");
