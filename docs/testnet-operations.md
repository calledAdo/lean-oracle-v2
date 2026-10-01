# Testnet operations

Lean Oracle testnet runs on one DigitalOcean droplet (London, 1 vCPU / 1 GB + 2 GB swap, Ubuntu 24.04).

- Public mirror: **https://64-227-40-35.sslip.io** (the SDK's `leanOracleTestnetPreset.mirrorUrls`).
- Server: `root@64.227.40.35` (SSH key login). Firewall (ufw): 22, 80, 443 only.
- Deployment record: [`deployments/testnet.json`](../deployments/testnet.json). Contracts v3 (the v1
  contract freeze, reproducible, [`contracts/checksums.txt`](../contracts/checksums.txt)) since
  2026-09-26; one committee, `majors` (12 feeds, CKB pairs included), under the always-success lock,
  one publisher (quorum 1). v1 and v2, and the v2 `majors` and `ckb` committees, are retired.

## Layout

`/opt/lean-oracle` (mode 700), a Docker Compose stack:

| Service | Image | Role |
|---|---|---|
| `majors` | `ghcr.io/calledado/lean-oracle-publisher:sha-…` | Publisher, majors committee (1 s ticks) |
| `mirror` | `ghcr.io/calledado/lean-oracle-mirror:sha-…` | Verified archive and public API |
| `caddy` | `caddy:2-alpine` | HTTPS (Let's Encrypt) in front of the mirror |
| `watchdog` | `ghcr.io/calledado/lean-oracle-watchdog:sha-…` | Telegram alerts (compose profile `alerts`) |

Only Caddy is exposed. Data volumes are `majors-data-v3` and `mirror-data-v3` (the v2 volumes are kept,
unused, for rollback; v3 stores refuse the v2 format). `majors/` holds the publisher's operator config, signed committee
config (`configs/v1.json`) and the publisher key (`publisher.key`, owner uid 1000, mode 600). The
local source of these files is `secrets/testnet-run/vps/` (git-ignored).

## Market-data recording

Since 2026-09-27 the `majors` publisher records market data (operator config `record`, with
`depthFeeds` set to the CKB pairs) into `majors-data-v3:/recordings`. The files are hourly gzip
NDJSON, capped at 2 GB with the oldest hours deleted first. Recording is measurement for
docs/designs/manipulation-resistant-pricing.md and never affects pricing. Copy the files off daily:

```bash
rsync -a root@64.227.40.35:/var/lib/docker/volumes/lean-oracle_majors-data-v3/_data/recordings/ ~/lean-recordings/
```

## Alerts and backups

- **Watchdog** (`apps/watchdog`): every 30 s it checks each publisher's latest finalized tick
  (majors 30 s), the public mirror (HTTPS, per-committee freshness) and new equivocation
  evidence. It alerts on Telegram on the second consecutive failure, reminds hourly, reports
  recovery, and sends a summary daily at 08:00 UTC. Its secrets live in `watchdog.env` (mode 600:
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`); start it with
  `docker compose --profile alerts up -d watchdog`.
- **Backups:** `backup.sh` ([source](../ops/testnet/backup.sh)) runs from cron at 03:30 UTC and
  takes about 3–4 minutes. It writes `backups/<date>/`:
  - `publisher.sqlite.gz`: the whole publisher store (double-sign guard, key sets, EMA state);
  - `mirror-24h.sqlite.gz`: the mirror's last 24 hours plus all equivocation evidence. Older mirror
    history is not backed up: it serves replays, and a restored mirror refills the last day from
    the publishers.

  Copies are consistent single-transaction snapshots (`VACUUM INTO`) at the lowest CPU priority.
  SQLite's `.backup`, used until 2026-10-01, restarted on every mirror write and ran for up to 17
  hours, starving the 1-vCPU droplet. Each copy is integrity-checked before it is kept. The 3 newest
  days are kept (by folder name), about 650 MB in total. A failure alerts on Telegram. Copy them off
  the droplet daily, since a lost droplet takes local backups with it:

  ```bash
  rsync -a root@64.227.40.35:/opt/lean-oracle/backups/ ~/lean-backups/
  ```

  DigitalOcean droplet backups are an alternative (a paid setting on the droplet).

## Everyday commands

```bash
ssh root@64.227.40.35 'cd /opt/lean-oracle && docker compose ps'
```

```bash
ssh root@64.227.40.35 'cd /opt/lean-oracle && docker compose logs --since 5m majors | tail -50'
```

```bash
curl -s https://64-227-40-35.sslip.io/health
```

## Shipping new images

Every push to `main` builds multi-arch images on GitHub (public, no login needed):
`ghcr.io/calledado/lean-oracle-publisher` and `ghcr.io/calledado/lean-oracle-mirror`, tagged `edge`
and `sha-<commit>`. The droplet pins a `sha-<commit>` tag, so a signer never changes version by
surprise. To upgrade, change the tag in `compose.yaml` and pull:

```bash
ssh root@64.227.40.35 'cd /opt/lean-oracle && sed -i "s#:sha-[0-9a-f]*#:sha-NEWSHA#" compose.yaml && docker compose pull -q && docker compose up -d'
```

## Changing configs

Copy files with `COPYFILE_DISABLE=1 tar ...` from macOS. Otherwise macOS adds `._*` files, and the
publisher tries to load `configs/._v1.json` as a committee config and exits.

A new committee config version is added as `configs/v<n>.json` (signed by a quorum,
`lean-oracle-publisher sign-config`); publishers pick it up without a restart.

## Rules

- **Never run a second publisher with the same key** (for example the local Docker stack). Two
  signers with one key can sign two different updates for the same tick, which the mirror records
  as equivocation.
- To use a real domain: point its DNS at 64.227.40.35, change the host name in `Caddyfile`, run
  `docker compose restart caddy`, then update `mirrorUrls` in `packages/sdk/src/presets/networks.ts`.
