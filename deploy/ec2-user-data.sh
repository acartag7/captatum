#!/usr/bin/env bash
# EC2 cloud-init user-data for a self-hosted captatum gateway.
# Paste into the EC2 launch "User data" field. Tested on Amazon Linux 2023 and
# Ubuntu 24.04. Front it with a Cloudflare Tunnel (set up separately) to
# 127.0.0.1:3000 — the gateway is never exposed directly.
#
# Secrets: this script expects an /opt/captatum/.env file. Provide it via your
# preferred channel (e.g. fetch from S3/SSM Parameter Store in a real setup, or
# ssh in and write it after first boot). Generate its OAuth keys with
# `node --no-warnings scripts/gen-oauth-keys.ts`.
set -euo pipefail

APP=/opt/captatum
mkdir -p "$APP"

# 1) Docker Engine + compose plugin
if command -v dnf >/dev/null 2>&1; then
  dnf install -y docker
else
  apt-get update && apt-get install -y docker.io
fi
systemctl enable --now docker
# Ensure the compose plugin (v2) is present; fall back to the install script.
docker compose version >/dev/null 2>&1 || \
  curl -fsSL https://get.docker.com | sh

# 2) The common compose definition (pulls published images; set CAPTATUM_TAG).
cat > "$APP/docker-compose.yml" <<'YAML'
services:
  gateway:
    image: ghcr.io/acartag7/captatum:${CAPTATUM_TAG:-latest}
    environment:
      HOST: "0.0.0.0"
      CAPTATUM_SQLITE_PATH: "/data/captatum.sqlite"
      CAPTATUM_TRUSTED_PROXY_CIDRS: "172.29.255.249/32"
    env_file: /opt/captatum/.env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - captatum-data:/data
    restart: unless-stopped
volumes:
  captatum-data:
networks:
  default:
    ipam:
      config:
        - subnet: "172.29.255.248/29"
          gateway: "172.29.255.249"
YAML

# 3) .env must exist before up. If it doesn't, exit non-zero so cloud-init marks
#    the launch failed (the gateway would fail-closed at boot anyway — be explicit).
#    Provide /opt/captatum/.env via SSM/S3 in a real user-data, or write it on first
#    boot and re-run `docker compose -f $APP/docker-compose.yml up -d`.
if [ ! -f "$APP/.env" ]; then
  echo "captatum: $APP/.env missing — create it (see deploy/README.md) then run: docker compose -f $APP/docker-compose.yml up -d" >&2
  exit 1
fi

# 4) Pull + run. cloudflared (separate service) reaches 127.0.0.1:3000.
cd "$APP"
docker compose pull
docker compose up -d
