-- CreateTable
CREATE TABLE "WebsiteCheck" (
    "url" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteCheck_pkey" PRIMARY KEY ("url")
);
