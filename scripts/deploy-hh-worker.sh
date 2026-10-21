#!/usr/bin/env bash
# Deploy the standalone HH worker (#187) on the RU host.
#
#   scripts/deploy-hh-worker.sh <HH_SHA> [--from-dir <release dir>] [--stage-only] [--no-timer]
#
# The worker is a separate service: its own user, its own release directory, its
# own state directories, its own limits, its own journal and its own rollback.
# Nothing of the retiring agent is moved here — the release is the HH skill
# alone, and the core agent that used to mount it stays where it was.
#
# The release content comes either from a source checkout on the host
# (--from-repo) or from a directory prepared elsewhere (--from-dir). The second
# mode is the normal one: the release travels as a file, so the host needs no
# repository credentials at all.
#
# The environment file (secrets, public URLs) is never created here: it must
# already exist at /etc/trained-assist-hh-worker/worker.env, owned by root with
# mode 0600.
set -Eeuo pipefail

HH_REV="${1:-}"
FROM_DIR=""
STAGE_ONLY=0
ENABLE_TIMER=1
SERVICE=hh-worker
TICK_SERVICE=hh-worker-tick
TIMER=hh-worker.timer
WORKER_ROOT="${HH_WORKER_ROOT:-/opt/trained-assist-hh-worker}"
RELEASES_DIR="$WORKER_ROOT/releases"
CURRENT_LINK="$WORKER_ROOT/current"
STATE_ROOT="${HH_WORKER_STATE_ROOT:-/var/lib/trained-assist-hh-worker}"
ENV_FILE="${HH_WORKER_ENV_FILE:-/etc/trained-assist-hh-worker/worker.env}"
SERVICE_USER="${HH_WORKER_USER:-hh-worker}"
SERVICE_GROUP="${HH_WORKER_GROUP:-hh-worker}"
PORT="${HH_WORKER_PORT:-8091}"
SOURCE_REPO="${HH_SOURCE_REPO:-/home/vova/trained-assist-hh-skill}"
RECORDS_DIR="$STATE_ROOT/deploy-records"

usage() {
  echo "Usage: $0 <HH_SHA> [--from-dir <dir>] [--stage-only] [--no-timer]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir) FROM_DIR="${2:-}"; shift 2 ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    --no-timer) ENABLE_TIMER=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[[ "$HH_REV" =~ ^[0-9a-f]{40}$ ]] || { echo 'HH_SHA must be a 40-hex revision' >&2; exit 2; }
[ -n "$FROM_DIR" ] || { echo '--from-dir is required (the release travels as a file)' >&2; exit 2; }
[ -d "$FROM_DIR" ] || { echo "Release directory not found: $FROM_DIR" >&2; exit 2; }
[ -f "$FROM_DIR/.release-sha" ] || { echo 'Release has no .release-sha marker' >&2; exit 2; }
[ "$(cat "$FROM_DIR/.release-sha")" = "$HH_REV" ] || { echo 'Release marker does not match HH_SHA' >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "Environment file is missing: $ENV_FILE" >&2; exit 2; }

SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo >/dev/null 2>&1 || { echo 'Need root or sudo' >&2; exit 1; }
  SUDO="sudo"
fi

TARGET_DIR="$RELEASES_DIR/$HH_REV"
PREVIOUS_CURRENT=""
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_CURRENT="$(readlink -f "$CURRENT_LINK")"
fi

rollback() {
  local code=$?
  trap - ERR
  echo 'Deployment failed — restoring the previous release' >&2
  if [ -n "$PREVIOUS_CURRENT" ] && [ -d "$PREVIOUS_CURRENT" ]; then
    $SUDO ln -sfn "$PREVIOUS_CURRENT" "$CURRENT_LINK.new.$$"
    $SUDO mv -Tf "$CURRENT_LINK.new.$$" "$CURRENT_LINK"
    $SUDO systemctl restart "$SERVICE" || true
  fi
  exit "$code"
}
trap rollback ERR

echo "== HH worker deploy: $HH_REV"

# ── service account and directories ───────────────────────────────────────────
if ! getent group "$SERVICE_GROUP" >/dev/null; then
  $SUDO groupadd --system "$SERVICE_GROUP"
fi
if ! getent passwd "$SERVICE_USER" >/dev/null; then
  $SUDO useradd --system --gid "$SERVICE_GROUP" --home-dir "$STATE_ROOT" \
    --shell /usr/sbin/nologin "$SERVICE_USER"
fi

$SUDO install -d -m 0755 -o root -g root "$WORKER_ROOT" "$RELEASES_DIR"
$SUDO install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_ROOT"
for dir in users data state agent-tokens logs; do
  $SUDO install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_ROOT/$dir"
done
$SUDO install -d -m 0750 -o root -g "$SERVICE_GROUP" "$(dirname "$ENV_FILE")"
$SUDO chmod 0640 "$ENV_FILE"

# ── release ───────────────────────────────────────────────────────────────────
if [ -d "$TARGET_DIR" ]; then
  echo "Release $HH_REV is already unpacked — reusing it"
else
  STAGING="$RELEASES_DIR/.staging-$HH_REV-$$"
  $SUDO install -d -m 0755 -o root -g root "$STAGING"
  $SUDO cp -a "$FROM_DIR/." "$STAGING/"
  $SUDO chown -R root:root "$STAGING"
  $SUDO chmod -R a+rX "$STAGING"
  $SUDO mv -T "$STAGING" "$TARGET_DIR"
fi

# ── gates ─────────────────────────────────────────────────────────────────────
echo '-- gates'
( cd "$TARGET_DIR" && node --test tests/guards/guards.test.cjs )
( cd "$TARGET_DIR" && node --test tests/hh-worker-cron.run.cjs tests/hh-worker-schedule-store.run.cjs tests/hh-worker-credentials.run.cjs )
( cd "$TARGET_DIR" && node -e "require('./src/hh-worker.js'); require('./src/hh-worker-tick.js');" )

# ── units ─────────────────────────────────────────────────────────────────────
UNIT_SRC="$TARGET_DIR/ops"
$SUDO install -m 0644 -o root -g root "$UNIT_SRC/hh-worker.service" /etc/systemd/system/hh-worker.service
$SUDO install -m 0644 -o root -g root "$UNIT_SRC/hh-worker-tick.service" /etc/systemd/system/hh-worker-tick.service
$SUDO install -m 0644 -o root -g root "$UNIT_SRC/hh-worker.timer" /etc/systemd/system/hh-worker.timer
$SUDO systemctl daemon-reload

if [ "$STAGE_ONLY" = "1" ]; then
  echo "Staged release at $TARGET_DIR (not activated)"
  exit 0
fi

# ── activation ────────────────────────────────────────────────────────────────
$SUDO ln -sfn "$TARGET_DIR" "$CURRENT_LINK.new.$$"
$SUDO mv -Tf "$CURRENT_LINK.new.$$" "$CURRENT_LINK"
$SUDO systemctl restart "$SERVICE"
sleep 2
HEALTH_CODE=$(curl -s -o /tmp/hh-worker-health.json -w '%{http_code}' -m 10 "http://127.0.0.1:$PORT/health" || true)
if [ "$HEALTH_CODE" != "200" ]; then
  echo "Health check failed (HTTP $HEALTH_CODE)" >&2
  $SUDO journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  false
fi
echo "-- health: $(cat /tmp/hh-worker-health.json)"

if [ "$ENABLE_TIMER" = "1" ]; then
  $SUDO systemctl enable --now "$TIMER"
  echo "-- timer: $(systemctl is-active "$TIMER")"
fi

# ── record ────────────────────────────────────────────────────────────────────
$SUDO install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$RECORDS_DIR"
RECORD="$RECORDS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$HH_REV.json"
$SUDO tee "$RECORD" >/dev/null <<JSON
{
  "revision": "$HH_REV",
  "previous_revision": "${PREVIOUS_CURRENT##*/}",
  "target_dir": "$TARGET_DIR",
  "previous_dir": "$PREVIOUS_CURRENT",
  "service": "$SERVICE",
  "timer": "$TIMER",
  "port": $PORT,
  "activated": true,
  "recorded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
$SUDO chmod 0600 "$RECORD"
echo "== HH worker live: $HH_REV (record $RECORD)"
