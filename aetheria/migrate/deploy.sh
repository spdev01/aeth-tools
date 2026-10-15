#!/usr/bin/env bash
# deploy.sh — install / update Aetheria on Debian from an aetheria-transfer.tar.gz built by migrate/export.ps1.
# Idempotent: run it again anytime to push the current state of the Windows checkout to the server.
#
# Usage (on the Debian server):
#   sudo bash deploy.sh ~/aetheria-transfer.tar.gz [--bootstrap] [--install-dir /opt/aetheria]
#     --bootstrap   install missing system packages first (Node 20 via NodeSource, tor, rsync, curl)
#
# What it does: extracts the archive, rsyncs it into $INSTALL_DIR (keeping server-side node_modules and
# logs), rewrites the Windows absolute paths inside the torrc files, installs npm deps, installs + enables
# the systemd units (aetheria-tor1/2, aetheria-cc, aetheria-fleetup.timer) and restarts the whole stack.
set -euo pipefail

ARCHIVE="${1:-}"
shift || true
BOOTSTRAP=0
INSTALL_DIR="/opt/aetheria"
while [ $# -gt 0 ]; do
  case "$1" in
    --bootstrap) BOOTSTRAP=1 ;;
    --install-dir) INSTALL_DIR="$2"; shift ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
  shift
done
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "usage: sudo bash deploy.sh <aetheria-transfer.tar.gz> [--bootstrap] [--install-dir DIR]"
  exit 1
fi
[ "$(id -u)" = "0" ] || { echo "run with sudo"; exit 1; }

APP_USER="aetheria"
say() { echo -e "\n== $* =="; }

if [ "$BOOTSTRAP" = "1" ]; then
  say "bootstrap: system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates rsync
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  command -v tor >/dev/null 2>&1 || apt-get install -y tor
fi
command -v node >/dev/null 2>&1 || { echo "node missing — rerun with --bootstrap"; exit 1; }
command -v tor  >/dev/null 2>&1 || { echo "tor missing  — rerun with --bootstrap"; exit 1; }
NODE_BIN="$(command -v node)"
TOR_BIN="$(command -v tor)"

id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"

say "stop running services (if any)"
systemctl stop aetheria-fleetup.timer aetheria-fleetup.service aetheria-cc.service aetheria-tor1.service aetheria-tor2.service 2>/dev/null || true

say "extract archive"
STAGE="$(mktemp -d /tmp/aetheria-stage.XXXXXX)"
tar -xzf "$ARCHIVE" -C "$STAGE"

say "sync into $INSTALL_DIR (keeps node_modules + server-side logs)"
mkdir -p "$INSTALL_DIR"
# --delete mirrors the checkout; excluded paths are never deleted (node_modules, logs, run logs)
rsync -a --delete \
  --exclude node_modules --exclude '*.log' --exclude 'run-*.jsonl' --exclude 'migrate/out' \
  "$STAGE/" "$INSTALL_DIR/"

say "rewrite torrc paths (Windows checkout paths -> $INSTALL_DIR)"
for f in "$INSTALL_DIR/command-center/data/tor/torrc" "$INSTALL_DIR/command-center/data/tor2/torrc"; do
  if [ -f "$f" ]; then
    sed -i -E "s#[A-Za-z]:/[^[:space:]]*aetheria/command-center#$INSTALL_DIR/command-center#g" "$f"
  fi
done

say "npm dependencies"
( cd "$INSTALL_DIR/testbot" && npm ci --omit=dev --no-audit --no-fund )
( cd "$INSTALL_DIR/command-center" && { npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund; } )

say "permissions"
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/command-center/data/store.json" 2>/dev/null || true
chmod 600 "$INSTALL_DIR/auth_config.json" 2>/dev/null || true
chmod +x "$INSTALL_DIR/migrate"/*.sh 2>/dev/null || true

say "systemd units"
for u in aetheria-tor1.service aetheria-tor2.service aetheria-cc.service aetheria-fleetup.service aetheria-fleetup.timer; do
  sed -e "s#__INSTALL__#$INSTALL_DIR#g" -e "s#__NODE__#$NODE_BIN#g" -e "s#__TOR__#$TOR_BIN#g" -e "s#__USER__#$APP_USER#g" \
    "$INSTALL_DIR/migrate/systemd/$u" > "/etc/systemd/system/$u"
done
systemctl daemon-reload

say "enable + start (auto-starts on every boot / power cycle)"
systemctl enable --now aetheria-tor1.service aetheria-tor2.service aetheria-cc.service
systemctl enable --now aetheria-fleetup.timer
systemctl start aetheria-fleetup.service || true   # immediate first fleet pass

sleep 5
say "health"
bash "$INSTALL_DIR/migrate/health.sh" || true

say "done"
echo "dashboard (localhost only):  http://127.0.0.1:4310"
echo "from your PC:                ssh -L 4310:127.0.0.1:4310 $APP_USER@<SERVER-IP>   then open http://127.0.0.1:4310"
echo "logs:                        journalctl -u aetheria-cc -f   |   journalctl -u aetheria-tor1 -f"
