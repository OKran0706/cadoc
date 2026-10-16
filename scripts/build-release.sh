#!/usr/bin/env bash
# build-release.sh - build Sentinel release artifacts served by nginx at /downloads and /install.sh.
# Output: deploy/downloads/{sentinel-linux-<arch>,.sha256,sentinel-assets.tar.gz,ca.crt,install-sentinel.sh}
# Run on the dev machine before transferring `deploy/` to EC2.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/deploy/downloads"
mkdir -p "$OUT"

cd "${ROOT}/src/sentinel"
for ARCH in amd64 arm64; do
  echo "[*] Building sentinel-linux-${ARCH}..."
  CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags="-s -w" \
    -o "${OUT}/sentinel-linux-${ARCH}" ./cmd/sentinel-a
  ( cd "$OUT" && sha256sum "sentinel-linux-${ARCH}" > "sentinel-linux-${ARCH}.sha256" )
done

echo "[*] Packaging templates and profiles..."
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp -r "${ROOT}/src/sentinel/templates" "${STAGE}/templates"
cp -r "${ROOT}/config/profiles" "${STAGE}/profiles"
tar -czf "${OUT}/sentinel-assets.tar.gz" -C "$STAGE" templates profiles

cp -f "${ROOT}/scripts/install-sentinel.sh" "${OUT}/install-sentinel.sh"
if [ -f "${ROOT}/deploy/certs/ca.crt" ]; then
  cp -f "${ROOT}/deploy/certs/ca.crt" "${OUT}/ca.crt"
else
  echo "NOTE: deploy/certs/ca.crt not found locally; deploy/ec2-setup.sh copies it on the server."
fi

echo "[ok] Release artifacts in ${OUT}:"
ls -l "$OUT"
