#!/usr/bin/env bash
# Reproducible contract build: always inside the same pinned Rust image on linux/amd64, with the
# repository at /src and CARGO_HOME at /cargo, so every machine produces byte-identical binaries
# (paths are compiled into panic locations, and rustc's output differs between host
# architectures). On Apple Silicon, enable Docker Desktop's "Use Rosetta for x86_64/amd64
# emulation" (QEMU crashes rustc). Writes target/riscv64imac-unknown-none-elf/release/* and
# checks them against contracts/checksums.txt unless --update is given.
#
#   scripts/build-contracts.sh            build and verify
#   scripts/build-contracts.sh --update   build and record new checksums (after a code change)
set -euo pipefail

IMAGE="rust:1.92-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="target/riscv64imac-unknown-none-elf/release"
CONTRACTS=(price_feed_type publisher_set_type)

docker run --rm --platform linux/amd64 \
  -v "$ROOT":/src -w /src \
  -v lean-oracle-cargo:/cargo -e CARGO_HOME=/cargo \
  -e SOURCE_DATE_EPOCH=0 -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$IMAGE" \
  bash -c 'rustup show active-toolchain >/dev/null && cargo build --release --locked -p price_feed_type -p publisher_set_type; status=$?; chown -R "$HOST_UID:$HOST_GID" /src/target; exit $status'

cd "$ROOT"
hash() { python3 -c 'import hashlib,sys;d=open(sys.argv[1],"rb").read();print("0x"+hashlib.blake2b(d,digest_size=32,person=b"ckb-default-hash").hexdigest(), len(d))' "$1"; }
current=$(for c in "${CONTRACTS[@]}"; do echo "$c $(hash "$OUT/$c")"; done)

if [[ "${1:-}" == "--update" ]]; then
  { echo "# ckb_hash (the data2 code hash) and size of each contract built by scripts/build-contracts.sh"; echo "$current"; } > contracts/checksums.txt
  echo "$current"
  exit 0
fi
expected=$(grep -v '^#' contracts/checksums.txt)
echo "$current"
# In GitHub Actions, surface the hashes as annotations.
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then while read -r c h n; do echo "::notice title=$c::$h ($n bytes)"; done <<< "$current"; fi
if [[ "$current" != "$expected" ]]; then
  echo "contract binaries differ from contracts/checksums.txt:" >&2
  diff <(echo "$expected") <(echo "$current") >&2 || true
  exit 1
fi
echo "binaries match contracts/checksums.txt"
