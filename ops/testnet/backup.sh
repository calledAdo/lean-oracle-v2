#!/usr/bin/env bash
# Nightly backup for the testnet droplet. Installed by cron: 30 3 * * * /opt/lean-oracle/backup.sh
#
#   publisher.sqlite.gz  the whole publisher store: its double-sign guard, key sets and EMA state.
#   mirror-24h.sqlite.gz the mirror's last 24 hours plus all equivocation evidence. Older history is
#                        not backed up: it serves replays, and a restored mirror refills the last day
#                        from the publishers.
#
# Copies are consistent snapshots taken in one read transaction (`VACUUM INTO` and a single
# INSERT ... SELECT transaction), so they never restart while the services write, unlike SQLite's
# `.backup`, which restarted on every write and ran for up to 17 hours. Work runs at the lowest CPU
# and I/O priority. Keeps the 3 newest days (by the date in the folder name) in
# /opt/lean-oracle/backups. On failure, alerts through the watchdog's Telegram settings. Copy the
# backups off the droplet daily (docs/testnet-operations.md); a dead droplet takes local copies with it.
set -uo pipefail
cd /opt/lean-oracle
day=$(date -u +%F)
dest="backups/$day"
mkdir -p "$dest"
started=$(date +%s)

fail() {
  echo "backup failed: $1" >&2
  if [[ -f watchdog.env ]]; then
    set -a; . ./watchdog.env; set +a
    curl -s -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="$TELEGRAM_CHAT_ID" -d text="[${WATCH_NAME:-lean-oracle}] 🚨 nightly backup failed: $1" >/dev/null
  fi
  exit 1
}

# Run sqlite3 against a volume (opened read-only; WAL readers still need its -shm file) with the backup folder at /out, at low priority.
sql() {
  local volume="$1"; shift
  docker run --rm -v "$volume":/data -v "$PWD/$dest":/out alpine:3 \
    sh -c "renice -n 19 \$\$ >/dev/null; apk add -q sqlite >/dev/null && $*"
}

rm -f "$dest"/*.sqlite "$dest"/*.sqlite.gz

# Publisher: the whole store.
sql lean-oracle_majors-data-v3 "sqlite3 'file:/data/publisher.sqlite?mode=ro' \"VACUUM INTO '/out/publisher.sqlite'\"" \
  || fail "publisher store"

# Mirror: same schema and format version, the last 24 h of updates, every equivocation.
cutoff=$(( ($(date +%s) - 86400) * 1000 ))
sql lean-oracle_mirror-data-v3 "
  version=\$(sqlite3 'file:/data/mirror.db?mode=ro' 'PRAGMA user_version') &&
  sqlite3 'file:/data/mirror.db?mode=ro' .schema | grep -v '^CREATE TABLE sqlite_' | sqlite3 /out/mirror-24h.sqlite &&
  sqlite3 /out/mirror-24h.sqlite \"
    ATTACH 'file:/data/mirror.db?mode=ro' AS s;
    BEGIN;
    INSERT INTO updates SELECT * FROM s.updates WHERE tick_ms >= $cutoff;
    INSERT INTO feed_ticks SELECT * FROM s.feed_ticks WHERE tick_ms >= $cutoff;
    INSERT INTO equivocations SELECT * FROM s.equivocations;
    COMMIT;
    PRAGMA user_version = \$version;\"" \
  || fail "mirror (last 24 h)"

# Check both copies before keeping them.
for f in publisher.sqlite mirror-24h.sqlite; do
  ok=$(docker run --rm -v "$PWD/$dest":/out alpine:3 sh -c "apk add -q sqlite >/dev/null && sqlite3 /out/$f 'PRAGMA quick_check'") \
    && [[ "$ok" == "ok" ]] || fail "$f failed its integrity check"
done
nice -n 19 gzip -f "$dest"/publisher.sqlite "$dest"/mirror-24h.sqlite || fail "gzip"

# Keep the 3 newest days, by the date in the folder name (folder mtimes change after creation).
oldest_kept=$(date -u -d "$day - 2 days" +%F)
for d in backups/*/; do
  name=$(basename "$d")
  [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$name" < "$oldest_kept" ]] && rm -rf "$d"
done

echo "backup ok: $dest $(du -sh "$dest" | cut -f1) in $(( $(date +%s) - started )) s"
