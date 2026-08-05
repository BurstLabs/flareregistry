-- Removal standing for sitting Management Group members. removeMember() is permissionless, so a
-- member can be one stranger's transaction away from losing their seat with no notice.
ALTER TABLE "ProviderOnchain"
  ADD COLUMN "mgRemovable"         BOOLEAN,
  ADD COLUMN "mgRemoveVerdict"     TEXT,
  ADD COLUMN "mgRemoveReason"      TEXT,
  ADD COLUMN "mgMissedVotes"       INTEGER,
  ADD COLUMN "mgRelevantProposals" INTEGER,
  ADD COLUMN "mgMissedVotesLimit"  INTEGER,
  ADD COLUMN "mgEpochsSinceReward" INTEGER;
