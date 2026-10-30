#!/usr/bin/env bash
# Resolve "active since" for providers that do not have it yet.
#
# Runs just after the daily import scan (05:40), so an entity discovered this morning is dated the
# same day rather than waiting for someone to notice the gap.
#
# Cheap when there is nothing to do: the script only selects rows where firstActivityAt is null, so a
# normal day is one database query and no explorer traffic at all. It never revisits a row it has
# already resolved, because the answer cannot change: an address's first transaction is immutable.
set -Eeuo pipefail
cd /home/deploy/flareregistry
set -a; source .env 2>/dev/null; set +a
node scripts/backfill-first-activity.mjs --apply >> /home/deploy/backups/flareregistry-first-activity.log 2>&1
