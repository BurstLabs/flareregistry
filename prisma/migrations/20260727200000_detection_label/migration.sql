CREATE TABLE "DetectionLabel" (
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DetectionLabel_pkey" PRIMARY KEY ("address")
);
