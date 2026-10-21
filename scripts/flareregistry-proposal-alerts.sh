#!/usr/bin/env bash
# Management Group proposal alerts: new proposals, and the optional halfway nudge.
#
# NOT YET INSTALLED ON THE BOX. Copy to /home/deploy/scripts/ and add the crontab line below once
# the feature is approved and deployed:
#
#   */10 * * * * /usr/bin/flock -n /tmp/flareregistry-proposal-alerts.lock /home/deploy/scripts/flareregistry-proposal-alerts.sh
#
# TEN MINUTES is chosen by what it is watching. A proposal appearing is the thing worth being quick
# about, and the midpoint of a 48-hour window does not need better resolution than that. The
# proposal read behind it is cached for two minutes, so a tighter schedule would mostly re-read the
# same answer.
#
# flock because the job sends mail: two overlapping runs are the one thing worth ruling out at the
# scheduler as well as in the code. The endpoint claims every send behind a unique index first, so a
# duplicate tick is already a no-op, but belt and braces is cheap here.
#
# SOURCE IS THE CHAIN, not our submit form. The endpoint reads the proposal list from
# PollingManagementGroup itself, so a proposal created on Flare's portal, from a script, or by any
# other member is picked up exactly like one created here.
set -Eeuo pipefail
cd /home/deploy/flareregistry
LOG=/home/deploy/backups/flareregistry-proposal-alerts.log
SECRET=$(grep -m1 '^INTERNAL_API_SECRET' .env | cut -d= -f2- | tr -d '"')
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

RESULT=$(curl -s --max-time 290 -X POST -H "Authorization: Bearer $SECRET" \
  http://127.0.0.1:3060/api/internal/proposal-alerts)

# Quiet unless something happened. This runs 144 times a day and almost every run has nothing to do;
# a line per tick buries the runs that sent something under a week of "sent":0.
if echo "$RESULT" | grep -qE '"sent":[1-9]|"failed":[1-9]|"ok":false'; then
  echo "$(ts) $RESULT" >> "$LOG"
fi
