# Testnet operations

Lean Oracle testnet runs on one DigitalOcean droplet (London, 1 vCPU / 1 GB + 2 GB swap, Ubuntu 24.04).

- Public mirror: **https://64-227-40-35.sslip.io** (the SDK's `leanOracleTestnetPreset.mirrorUrls`).
- Server: `root@64.227.40.35` (SSH key login). Firewall (ufw): 22, 80, 443 only.
- Deployment record: [`deployments/testnet.json`](../deployments/testnet.json). Committees `majors` and
  `ckb`, one publisher each (quorum 1).

## Layout

`/opt/lean-oracle` (mode 700), a Docker Compose stack:

| Service | Image | Role |
|---|---|---|
| `majors` | `lean-oracle-publisher:testnet` | Publisher, majors committee (1 s ticks) |
| `ckb` | `lean-oracle-publisher:testnet` | Publisher, CKB committee (2 s ticks) |
| `mirror` | `lean-oracle-mirror:testnet` | Verified archive and public API |
| `caddy` | `caddy:2-alpine` | HTTPS (Let's Encrypt) in front of the mirror |

Only Caddy is exposed. `majors/` and `ckb/` hold each publisher's operator config, signed committee
config (`configs/v1.json`) and the publisher key (`publisher.key`, owner uid 1000, mode 600). The
local source of these files is `secrets/testnet-run/vps/` (git-ignored).

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

The droplet is x86-64 and small, so images are built on a workstation and copied over:

```bash
docker buildx build --platform linux/amd64 -f apps/publisher/Dockerfile -t lean-oracle-publisher:testnet --load .
```

```bash
docker buildx build --platform linux/amd64 -f apps/mirror/Dockerfile -t lean-oracle-mirror:testnet --load .
```

```bash
docker save lean-oracle-publisher:testnet lean-oracle-mirror:testnet | gzip | ssh root@64.227.40.35 'gunzip | docker load'
```

```bash
ssh root@64.227.40.35 'cd /opt/lean-oracle && docker compose up -d'
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
