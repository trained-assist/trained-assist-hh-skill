#!/usr/bin/env bash
# Run on the GCP host after the reviewed HH commit is available in SOURCE_REPO.
# Builds while the old process serves; switches only the HH sibling, preserving
# the agent release and the source checkout. Error rollback restores both the
# previous HH link and the service. It does not publish or migrate vacancy data.
set -Eeuo pipefail
HH_REV="${1:-}"
EXPECTED_AGENT_REV="${2:-}"
[[ "$HH_REV" =~ ^[0-9a-f]{40}$ && "$EXPECTED_AGENT_REV" =~ ^[0-9a-f]{40}$ ]] || { echo 'Usage: deploy-hh-pinned.sh <HH-full-SHA> <live-agent-full-SHA>' >&2; exit 2; }
SOURCE_REPO="${HH_SOURCE_REPO:-/home/vova/trained-assist-hh-skill}"
HH_RELEASES="${HH_RELEASES_DIR:-/home/vova/hh-releases}"
AGENT_LINK="${HH_AGENT_LINK:-/home/vova/agent-master}"
SIBLING_LINK="${HH_SIBLING_LINK:-/home/vova/agent-releases/trained-assist-hh-skill}"
SERVICE="${HH_SERVICE:-assist-agent}"
SUDO="${SUDO-sudo}"
: "${HH_HUB_BASE:?Set the public HH_HUB_BASE for the actual HTTP route gate}"
: "${HH_HUB_USER:?Set HH_HUB_USER}"
: "${HH_HUB_TOKEN:?Set the recruiter HMAC in HH_HUB_TOKEN; never put it on the command line}"
exec 9>"${ASSIST_DEPLOY_LOCK_FILE:-/home/vova/.assist-deploy.lock}"
flock -n 9 || { echo 'Another deploy owns the lock' >&2; exit 1; }
AGENT_ROOT="$(readlink -f "$AGENT_LINK")"
[[ "$(cat "$AGENT_ROOT/.release-sha")" = "$EXPECTED_AGENT_REV" ]] || { echo 'Agent release changed; refusing cutover' >&2; exit 1; }
git -C "$SOURCE_REPO" cat-file -e "$HH_REV^{commit}"
[[ -L "$SIBLING_LINK" ]] || { echo 'HH sibling must be an existing symlink' >&2; exit 1; }
PREVIOUS_HH="$(readlink -f "$SIBLING_LINK")"
[[ -d "$PREVIOUS_HH" ]] || { echo 'Previous HH release missing; rollback unavailable' >&2; exit 1; }
# An explicit service override would bypass the sibling being switched.
LIVE_PID="$(systemctl show "$SERVICE" --property=MainPID --value)"
python3 - "$LIVE_PID" <<'PY'
import sys
with open('/proc/'+sys.argv[1]+'/environ','rb') as f:
    values=f.read().split(b'\0')
if any(v.startswith(b'HH_SKILL_DIR=') for v in values):
    raise SystemExit('Service overrides HH_SKILL_DIR; use its configured release link explicitly')
PY
TARGET_DIR="$HH_RELEASES/$HH_REV"
STAGING=""
if [[ ! -f "$TARGET_DIR/.release-complete" ]]; then
  STAGING="$(mktemp -d "${HH_STAGING_PARENT:-/home/vova}/.hh-release-staging.XXXXXXXX")"
  git -C "$SOURCE_REPO" archive "$HH_REV" | tar -x -C "$STAGING"
  npm ci --prefix "$STAGING" --ignore-scripts
  printf '%s\n' "$HH_REV" > "$STAGING/.release-sha"
  node "$STAGING/scripts/check-hh-route-ownership.cjs" "$AGENT_ROOT"
  node "$AGENT_ROOT/scripts/check-mcp-conformance.js" "$STAGING"
  node "$AGENT_ROOT/scripts/check-skill-schedule.js" "$STAGING"
  touch "$STAGING/.release-complete"
  $SUDO mkdir -p "$HH_RELEASES"
  $SUDO chown -R root:root "$STAGING"
  $SUDO chmod -R a+rX "$STAGING"
  $SUDO mv -T "$STAGING" "$TARGET_DIR"
  STAGING=""
fi
[[ "$(cat "$TARGET_DIR/.release-sha")" = "$HH_REV" ]] || { echo 'HH release marker mismatch' >&2; exit 1; }
node "$TARGET_DIR/scripts/check-hh-route-ownership.cjs" "$AGENT_ROOT"
if [[ "$PREVIOUS_HH" = "$TARGET_DIR" ]] && systemctl is-active --quiet "$SERVICE"; then
  node "$TARGET_DIR/scripts/verify-deploy.cjs" --rev "$HH_REV"
  echo "HH revision already live and verified; no restart"
  exit 0
fi
RECORD_DIR="${HH_DEPLOY_RECORDS_DIR:-/home/vova/hh-deploy-records}"
mkdir -p "$RECORD_DIR"
chmod 700 "$RECORD_DIR"
RECORD="$RECORD_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$HH_REV.json"
node - "$RECORD" "$PREVIOUS_HH" "$TARGET_DIR" "$EXPECTED_AGENT_REV" <<'JS'
require('fs').writeFileSync(process.argv[2], JSON.stringify({previous_hh:process.argv[3],target_hh:process.argv[4],agent_revision:process.argv[5]},null,2)+'\n',{mode:0o600});
JS
set_link() {
  local target="$1" temporary="$SIBLING_LINK.new.$$"
  $SUDO ln -sfn "$target" "$temporary"
  $SUDO mv -Tf "$temporary" "$SIBLING_LINK"
}
rollback() {
  local code=$?
  trap - ERR
  echo 'HH deployment failed; restoring previous HH release' >&2
  set_link "$PREVIOUS_HH"
  $SUDO systemctl restart "$SERVICE"
  exit "$code"
}
# Recheck under the same shared deploy lock immediately before activation.
[[ "$(readlink -f "$AGENT_LINK")" = "$AGENT_ROOT" ]] || { echo 'Agent changed during build' >&2; exit 1; }
trap rollback ERR
set_link "$TARGET_DIR"
$SUDO systemctl restart "$SERVICE"
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 1 http://127.0.0.1:8080/health >/dev/null; then break; fi
  sleep 1
done
$SUDO systemctl is-active --quiet "$SERVICE"
node "$TARGET_DIR/scripts/verify-deploy.cjs" --rev "$HH_REV"
printf '%s\n' "$HH_REV" > /home/vova/hh-deploy-target.new
mv /home/vova/hh-deploy-target.new /home/vova/hh-deploy-target
trap - ERR
printf 'HH pinned deployment verified: %s; rollback record: %s\n' "$HH_REV" "$RECORD"
