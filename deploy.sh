#!/usr/bin/env bash
# Flare Registry production deploy. Run on the Hetzner box as the `deploy` user:
#   /home/deploy/flareregistry/deploy.sh
#
# Order matters: `prisma generate` MUST run BEFORE `npm run build`. Running generate after the
# build wipes .next/BUILD_ID and pm2 crash-loops ("Could not find a production build").
set -Eeuo pipefail

cd /home/deploy/flareregistry

echo "==> fetching latest main"
GIT_SSH_COMMAND="ssh -o BatchMode=yes" git fetch origin main -q
git reset --hard origin/main -q
echo "    on $(git rev-parse --short HEAD)"

# INSTALL ONLY WHEN THE LOCKFILE ACTUALLY MOVED.
#
# npm ci deletes node_modules and reinstalls from scratch every time, and it was half the deploy:
# 19 seconds of a 38 second run, on deploys that almost always touch nothing but src/. The lockfile
# is what decides whether the tree is stale, so that is what is checked.
#
# Hashed AFTER the git reset above, so a deploy that DOES change dependencies still installs them.
# Guarded on node_modules/.package-lock.json as well, which npm writes on a successful install: the
# hash alone would happily skip the install on a box where node_modules had been wiped.
#
# DEPLOY_FORCE_INSTALL=1 reinstalls regardless, for the case where the tree is suspect and the hash
# cannot know it.
DEPS_HASH_FILE=.deploy-deps-hash
WANT_HASH=$(sha256sum package-lock.json | cut -d" " -f1)
HAVE_HASH=$(cat "$DEPS_HASH_FILE" 2>/dev/null || echo none)
if [ "${DEPLOY_FORCE_INSTALL:-0}" = "1" ] || [ "$WANT_HASH" != "$HAVE_HASH" ] || [ ! -f node_modules/.package-lock.json ]; then
  echo "==> npm ci (dependencies changed)"
  npm ci 2>&1 | tail -1
  echo "$WANT_HASH" > "$DEPS_HASH_FILE"
else
  echo "==> npm ci skipped (lockfile unchanged)"
fi

echo "==> prisma generate"
npx prisma generate >/dev/null 2>&1

echo "==> prisma migrate deploy"
npx prisma migrate deploy 2>&1 | tail -2

echo "==> next build"
npm run build 2>&1 | grep -E "Compiled|Error|Failed" | head -3

echo "==> pm2 restart"
pm2 restart flareregistry --update-env 2>&1 | tail -1

echo "==> health check"
sleep 3
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3060/)
echo "    localhost:3060 -> $code"
[ "$code" = "200" ] && echo "==> deploy OK" || { echo "==> deploy FAILED (non-200)"; exit 1; }
