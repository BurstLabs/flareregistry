-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "logoURI" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'submitted';

-- AlterTable
ALTER TABLE "ProviderAddress" ADD COLUMN     "listed" BOOLEAN NOT NULL DEFAULT false;
