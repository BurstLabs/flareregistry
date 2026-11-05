-- SHA-256 of the published logo bytes, so a consumer can verify the image it serves is the image
-- we published rather than taking a URL on trust.
ALTER TABLE "Provider" ADD COLUMN "logoSha256" TEXT;
