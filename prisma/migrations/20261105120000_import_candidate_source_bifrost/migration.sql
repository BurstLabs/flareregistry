-- The upstream catalog moved: TowoLabs/ftso-signal-providers was archived on 2026-11-05 and
-- bifrostwallet/assets is now the maintained source. The `source` tag on a staged candidate names
-- where we found it, so it has to follow, or an existing candidate would be invisible to the
-- enrichment lookup in scanImports (which reads source = 'bifrost') and a provider already seen
-- would be staged a second time.
UPDATE "ImportCandidate" SET "source" = 'bifrost' WHERE "source" = 'towolabs';
UPDATE "ImportCandidate" SET "source" = 'onchain+bifrost' WHERE "source" = 'onchain+towolabs';
