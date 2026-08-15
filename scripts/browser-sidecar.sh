#!/usr/bin/env bash
# Captatum browser sidecar — a long-lived headless Chromium exposing CDP, so the
# gateway connects to it (CAPTATUM_BROWSER_CDP_ENDPOINT=http://<host>:9222) and
# never launches a browser in its own process.
#
# WHY THIS EXISTS: blast-radius separation. A Chromium RCE/sandbox-escape escapes
# into THIS container (no OAuth keys, no DB creds, no env) — NOT into the gateway.
# `--no-sandbox` is acceptable HERE because the container is the isolation
# boundary; it is NOT acceptable in-process with the gateway. See
# docs/threat-model.md.
#
# The Chromium major version MUST match the gateway's `playwright` pin
# (package.json); a mismatch can break the CDP protocol.
set -euo pipefail

if [ "${CAPTATUM_BROWSER_CDP_PORT+x}" = "x" ]; then
  PORT="${CAPTATUM_BROWSER_CDP_PORT}"
else
  PORT="9222"
fi
if [ "${CAPTATUM_BROWSER_CDP_BIND_ADDRESS+x}" = "x" ]; then
  BIND_ADDRESS="${CAPTATUM_BROWSER_CDP_BIND_ADDRESS}"
else
  BIND_ADDRESS="127.0.0.1"
fi
case "${PORT}" in
  *[!0-9]*|"") echo "browser-sidecar: invalid CDP port" >&2; exit 1 ;;
esac
if [ "${PORT}" -lt 1 ] || [ "${PORT}" -gt 65535 ]; then
  echo "browser-sidecar: invalid CDP port" >&2
  exit 1
fi
case "${BIND_ADDRESS}" in
  127.0.0.1) ;;
  *) echo "browser-sidecar: invalid CDP bind address" >&2; exit 1 ;;
esac

# Locate the bundled Chromium. The mcr.microsoft.com/playwright image lays it out
# at /ms-playwright/chromium-<ver>/chrome-linux/chrome; fall back to PATH names.
CHROME="$(ls /ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1 || true)"
CHROME="${CHROME:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
if [ -z "${CHROME:-}" ]; then
  echo "browser-sidecar: no chromium binary found" >&2
  exit 1
fi

# Chromium remains loopback-only. The production browser Pod exposes it through
# the image's fixed, connection-capped CDP relay in a second no-secret container.
exec "${CHROME}" \
  --headless=new \
  --no-sandbox \
  --remote-debugging-port="${PORT}" \
  --remote-debugging-address="${BIND_ADDRESS}" \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --no-remote \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  about:blank
