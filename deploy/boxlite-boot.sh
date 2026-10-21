#!/bin/sh
set -eu
cd /opt/codingbox
if [ "$(id -u)" = 0 ]; then
  exec sudo -n -u boxlite sh /opt/codingbox/deploy/boxlite-boot.sh
fi
umask 077
mkdir -p .data
# A lock prevents duplicate portal supervisors on repeated bootstrap calls.
exec 9>.data/portal.lock
flock -n 9 || exit 0
echo $$ > .data/portal-supervisor.pid
trap 'exit 0' TERM INT
while true; do
  node_modules/.bin/tsx src/main.ts >> .data/server.log 2>&1 || true
  sleep 2
done
