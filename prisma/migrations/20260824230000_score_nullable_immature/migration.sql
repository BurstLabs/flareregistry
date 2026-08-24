-- An entity with too little history keeps a row carrying no figure, so the directory can say
-- "not scored yet" instead of showing an empty space that could equally mean departed, or
-- Songbird, or a bug.
ALTER TABLE "ProviderScore" ALTER COLUMN "score" DROP NOT NULL;
ALTER TABLE "ProviderScore" ALTER COLUMN "baseScore" DROP NOT NULL;
ALTER TABLE "ProviderScore" ALTER COLUMN "band" DROP NOT NULL;
