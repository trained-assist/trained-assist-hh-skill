# Standalone HH worker on the RU host (#187)

The HH surface of the product (pages `/hh/*`, the API `/api/hh/*`, the cold-search
scheduler) used to be served by the retiring GCP VM: the core agent's HTTP
server mounted the HH skill as a sibling, and the same server owned the generic
cron the cold-search schedules lived in. That host is gone, and the RU host
must not receive the whole retiring agent — only the HH part.

This document is the runbook for that worker: what it is, how it is installed,
how the nginx cutover is done without changing the user's URL, and how it is
rolled back.

## What the worker is

A separate systemd service (`hh-worker.service`) that owns:

| Piece | Where | Note |
|---|---|---|
| Service user | `hh-worker` (system account, no shell) | its own account, not `vova` |
| Release | `/opt/trained-assist-hh-worker/releases/<sha>` + `current` symlink | immutable, one directory per revision |
| Profile state | `/var/lib/trained-assist-hh-worker/users/<profile>` | ATS configs, active vacancies, stages |
| HH data | `/var/lib/trained-assist-hh-worker/data/hh/<profile>` | query cache, seen ids, candidates, snapshots |
| Credentials | `/var/lib/trained-assist-hh-worker/agent-tokens/<profile>` | bound explicitly, see below |
| Scheduler ledger | `/var/lib/trained-assist-hh-worker/state/schedule.json` | jobs + occurrences, mode 0600 |
| Deploy records | `/var/lib/trained-assist-hh-worker/deploy-records/` | one JSON per activation |
| Env / secrets | `/etc/trained-assist-hh-worker/worker.env` | root-owned, 0640 — never in the repository |
| Journal | `journalctl -u hh-worker` (identifier `hh-worker`) | every line of the worker |
| Timer | `hh-worker.timer` → `hh-worker-tick.service` | one tick per minute |

Limits and hardening live in `ops/hh-worker.service`: `MemoryMax=1024M`,
`CPUQuota=100%`, `TasksMax=128`, `ProtectSystem=strict`, `ProtectHome=read-only`,
`ReadWritePaths=/var/lib/trained-assist-hh-worker`, `NoNewPrivileges`,
`RestrictSUIDSGID`, `UMask=0077`.

## Code

- `src/hh-worker.js` — the HTTP listener. It serves the skill's own route table
  (`src/hh-routes.js`) for `/hh/*`, `/api/hh/*` and `/calltips-*`, keeps the
  agent's order (public routes first, then the Bearer-gated ones), and adds
  `/health` plus a small Bearer-gated admin API (`/hh-worker/jobs`,
  `/hh-worker/occurrences`, `/hh-worker/tick`). A path that starts with
  `/agent/` is accepted as well: the old host published the surface under
  `/agent/hh/…`, so links written before the cutover keep working.
- `src/hh-worker-host.js` — the host contract the routes expect: secrets,
  `readChatId`, `notifyProfile`, `runMcpTool` (the skill's own MCP registry, in
  process, serialized per call) and the negotiation helpers.
- `src/hh-worker-cron.js` — five-field cron in a named zone (`Europe/Moscow`).
  A broken expression throws instead of matching nothing.
- `src/hh-worker-schedule-store.js` — the durable store: one occurrence per
  `(job, scheduled_at)`, a lease with no overlap, and missed minutes coalesced
  into a single run.
- `src/hh-worker-tick.js` — one scheduler tick: materialize the due
  occurrences, claim them under the lease, run the cold search, record the
  outcome. A separate process from the HTTP worker, so a long search never
  blocks a page request.
- `src/hh-worker-credentials.js` — the explicit profile binding of the HH
  credential: the bound copy follows a re-login, and the worker can read and
  rewrite it (the HH token refresh writes a new value back).
- `src/hh-cold-search-cron.js` — one addition: with `HH_SCHEDULE_BACKEND=local`
  the skill's `hh_proactive_schedule` tool drives the worker's own store instead
  of the retiring agent's cron API. Without that variable nothing changes for
  the core deployment.

## Install

The release travels as a file, so the host needs no repository credentials:

```bash
# 1. build the release from the merged revision (locally)
git -C <repo> archive <sha> | tar -x -C /tmp/hh-worker-release
echo <sha> > /tmp/hh-worker-release/.release-sha

# 2. copy it to the host and run the installer
scp -r /tmp/hh-worker-release root@<ru-host>:/tmp/hh-worker-release
ssh root@<ru-host> 'bash scripts/deploy-hh-worker.sh <sha> --from-dir /tmp/hh-worker-release'
```

`scripts/deploy-hh-worker.sh` creates the account and the directories, unpacks
the release, runs the gates (`tests/guards/guards.test.cjs`, the worker's own
tests and a module-load smoke), installs the units, switches the `current`
symlink, restarts the service, checks `/health` and writes the deploy record.
On any failure it restores the previous release and restarts the service.

The environment file is never written by the installer. It must exist:

```
AGENT_SECRET=…            # the same value the recruiter's links were signed with
HH_CLIENT_ID=…            # from the OAuth app
HH_CLIENT_SECRET=…
TELEGRAM_BOT_TOKEN=…
AGENT_PUBLIC_URL=https://recruiter-assistant.ru
HH_PUBLIC_API_URL=https://recruiter-assistant.ru
HH_COLD_SEARCH_PUBLIC_URL=https://recruiter-assistant.ru
```

## Profile binding and data restore

The credentials and the profile data of the retired host are restored from the
frozen archive of the legacy content:

```bash
node scripts/hh-worker-restore-profile.cjs --profile <profile> \
  --archive /var/lib/trained-assist/recruiting-web/private-staging/<archive>.tar \
  --state-root /var/lib/trained-assist-hh-worker [--source-token <live file>]
```

It restores the ATS settings, the active vacancies, the stage and message
config, the query cache, the seen ids, the candidate store and the snapshots;
writes the credential; records the binding (`state/bindings.json`) and verifies
reading and writing. The report names files and counts — never a credential
value.

An encrypted credential whose master key is not available is **not** restored:
the worker would answer 401 and look broken. The report says so explicitly.

## Schedules

```bash
node scripts/hh-worker-migrate-schedules.cjs \
  --legacy-db /var/lib/trained-assist/recruiting-web/private-staging/<cron>.sqlite \
  --state-root /var/lib/trained-assist-hh-worker \
  --out /var/lib/trained-assist-hh-worker/state/legacy-schedule-mapping.json
```

Every legacy job keeps its id, its cron expression and its timezone. The jobs
arrive **disabled**: the legacy runs were paused on the retiring host and must
not be replayed blindly. A job whose last outcome is `unknown` is quarantined
(`quarantined_pending_owner`) — its last run may have been in flight when the
host went away, and a replay could apply the same work twice. The mapping file
is private (0600): it names vacancies.

Enabling a schedule is an explicit decision:

```bash
curl -sS -X POST http://127.0.0.1:8091/hh-worker/jobs \
  -H "Authorization: Bearer $AGENT_SECRET" -H 'Content-Type: application/json' \
  -d '{"op":"upsert","profile_id":"<profile>","name":"cold-search:<vacancy>","enabled":true}'
```

## nginx cutover (the user's URL does not change)

The old host published the surface under `/agent/hh/…`; the RU nginx rewrote
`/hh/<page>` to that path and proxied it to the dead GCP host. The cutover
replaces the upstream with the worker and drops the rewrite:

```nginx
location ^~ /hh/       { proxy_pass http://127.0.0.1:8091; … }
location ^~ /api/hh/   { proxy_pass http://127.0.0.1:8091; … }
```

`/hh-callback` and `/connect/hh` stay on the RU edge — the OAuth flow and the
credential storage do not move. The public URL (`https://recruiter-assistant.ru/hh/…`)
is unchanged.

## Rollback

1. `ln -sfn <previous release> /opt/trained-assist-hh-worker/current && systemctl restart hh-worker`
   (the previous release directory is kept, the deploy record names it), or
2. restore the previous nginx configuration (`/etc/nginx/sites-enabled/recruiter-assistant.bak-<ts>`)
   and `nginx -t && systemctl reload nginx`.

The timer can be stopped without touching the service: `systemctl stop hh-worker.timer`.

## Known limitations

- Telegram push from the RU host goes through `TELEGRAM_API_URL`; the default
  Telegram endpoint may be unreachable from this network. The worker never fails
  a recruiter action because of a failed push.
- The working profile's credential in the legacy archive is encrypted with a
  master key that lived on the retired host. Until that key (or a fresh login)
  is available, the working profile's schedules stay imported and disabled.
