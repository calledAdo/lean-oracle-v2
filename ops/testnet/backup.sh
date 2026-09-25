#!/usr/bin/env bash
# Nightly backup of the mirror history and each publisher's store (which holds the double-sign
# guard), using SQLite's online backup so services keep running. Keeps 7 days in
# /opt/lean-oracle/backups. On failure, alerts through the watchdog's Telegram settings.
# Installed by cron: 30 3 * * * /opt/lean-oracle/backup.sh
set -uo pipefail
cd /opt/lean-oracle
day=$(date -u +%F)
dest="backups/$day"
mkdir -p "$dest"
fail() {
  echo "backup failed: $1" >&2
  if [[ -f watchdog.env ]]; then
    set -a; . ./watchdog.env; set +a
    curl -s -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="$TELEGRAM_CHAT_ID" -d text="[${WATCH_NAME:-lean-oracle}] 🚨 nightly backup failed: $1" >/dev/null
  fi
  exit 1
}
for item in "mirror-data:mirror.db" "majors-data:publisher.sqlite" "ckb-data:publisher.sqlite"; do
  volume="lean-oracle_${item%%:*}"; file="${item#*:}"; name="${item%%-data:*}"
  docker run --rm -v "$volume":/data -v "$PWD/$dest":/out alpine:3 \
    sh -c "apk add -q sqlite >/dev/null && sqlite3 /data/$file \".backup /out/$name.sqlite\" && gzip -f /out/$name.sqlite" \
    || fail "$name ($volume/$file)"
done
find backups -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
echo "backup ok: $dest $(du -sh "$dest" | cut -f1)"
