# Testnet operations

Lean Oracle testnet runs on one DigitalOcean droplet (London, 1 vCPU / 1 GB + 2 GB swap, Ubuntu 24.04).

- Public mirror: **https://64-227-40-35.sslip.io** (the SDK's `leanOracleTestnetPreset.mirrorUrls`).
- Server: `root@64.227.40.35` (SSH key login). Firewall (ufw): 22, 80, 443 only.
- Deployment record: [`deployments/testnet.json`](../deployments/testnet.json). Contracts v2 (reproducible,
  [`contracts/checksums.txt`](../contracts/checksums.txt)); committees `majors` and `ckb`, one publisher
  each (quorum 1). v1 (2026-09-25, not reproducible) is retired.

## Layout

`/opt/lean-oracle` (mode 700), a Docker Compose stack:

| Service | Image | Role |
|---|---|---|
| `majors` | `ghcr.io/calledado/lean-oracle-publisher:sha-…` | Publisher, majors committee (1 s ticks) |
| `ckb` | `ghcr.io/calledado/lean-oracle-publisher:sha-…` | Publisher, CKB committee (2 s ticks) |
| `mirror` | `ghcr.io/calledado/lean-oracle-mirror:sha-…` | Verified archive and public API |
| `caddy` | `caddy:2-alpine` | HTTPS (Let's Encrypt) in front of the mirror |
| `watchdog` | `ghcr.io/calledado/lean-oracle-watchdog:sha-…` | Telegram alerts (compose profile `alerts`) |

Only Caddy is exposed. `majors/` and `ckb/` hold each publisher's operator config, signed committee
config (`configs/v1.json`) and the publisher key (`publisher.key`, owner uid 1000, mode 600). The
local source of these files is `secrets/testnet-run/vps/` (git-ignored).

## Alerts and backups

- **Watchdog** (`apps/watchdog`): every 30 s it checks each publisher's latest finalized tick
  (majors 30 s, ckb 60 s), the public mirror (HTTPS, per-committee freshness) and new equivocation
  evidence. It alerts on Telegram on the second consecutive failure, reminds hourly, reports
  recovery, and sends a summary daily at 08:00 UTC. Its secrets live in `watchdog.env` (mode 600:
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`); start it with
  `docker compose --profile alerts up -d watchdog`.
- **Backups:** `backup.sh` ([source](../ops/testnet/backup.sh)) runs from cron at 03:30 UTC. It takes
  SQLite online backups of the mirror and both publisher stores into `backups/<date>/`, keeps 7
  days, and alerts on Telegram if a backup fails. Backups stay on the droplet; copy them off it
  (or enable DigitalOcean droplet backups) to survive losing the droplet.

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
