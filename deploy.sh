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

echo "==> npm ci"
npm ci 2>&1 | tail -1

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
