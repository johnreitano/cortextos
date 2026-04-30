# Migrating to External Persistent Crons

Crons used to die on every agent restart. They now survive indefinitely. This guide explains what changed, what you need to do (nothing), and how to verify.

---

## What Changed

- **Before:** Crons were session-local (CronCreate via Claude API). Each agent restart meant crons were gone and had to be manually re-created.
- **After:** Crons live in `${CTX_ROOT}/state/{agent}/crons.json` and are daemon-managed. The scheduler reads this file on every agent start and re-schedules all entries automatically.
- **Migration:** The daemon auto-migrates `config.json` crons to `crons.json` on first boot per agent. A marker file `.crons-migrated` prevents re-runs. The source `config.json` is left untouched — non-destructive.

---

## What You Need to Do

Nothing. Migration runs automatically on the next daemon start.

---

## Verification

After the daemon starts, confirm migration ran and crons are scheduled:

```bash
# Shows all crons with next_fire_at
cortextos bus list-crons <agent>

# Execution history once crons start firing
cortextos bus get-cron-log <agent>

# Marker confirming migration ran (exists = done)
ls "${CTX_ROOT}/state/{agent}/.crons-migrated"

# Populated cron definitions
cat "${CTX_ROOT}/state/{agent}/crons.json"
```

---

## Manual Migration (if needed)

If auto-migration did not run, or you need to re-run it for a specific agent:

```bash
# Re-run for one agent
cortextos bus migrate-crons <agent>

# Re-run for all enabled agents
cortextos bus migrate-crons

# Bypass the marker and re-run regardless
cortextos bus migrate-crons <agent> --force
```

---

## Troubleshooting

**Cron not firing:**
1. `cortextos bus list-crons <agent>` — confirm the cron is registered and has a `next_fire_at`
2. `cortextos bus get-cron-log <agent>` — check execution history for `status: retried` or `status: failed`
3. If PTY injection is failing, check the daemon log: `~/.cortextos/$CTX_INSTANCE_ID/logs/<agent>/`

**Migration did not run:**
- No marker file? Run `cortextos bus migrate-crons <agent>` manually.
- Check that `config.json` has a `crons` array — migration only imports from it if the array exists.

**Cron fires but agent does not react:**
- Check daemon log; PTY injection may have failed (three attempts: 1s, 4s, 16s backoff).
- `get-cron-log` will show `status: retried` entries.

**Malformed or empty crons.json:**
- If `crons.json` is corrupt (parse error), `readCrons()` automatically falls back to `crons.json.bak` — the previous good copy written by `writeCrons()`. A warning is logged to stderr; no operator action is required for a single corruption event.
- If both the primary file and the `.bak` are unparseable, `readCrons()` returns `[]` and the scheduler starts with an empty schedule. Fix: write a valid `crons.json` using `cortextos bus add-cron`, or restore from a known-good backup.
- **Reload-to-empty protection (`lastGoodSchedule`):** if a `reload()` produces an empty schedule on a running scheduler (e.g. transient file corruption mid-tick), the scheduler retains the last successfully loaded schedule in memory and logs a warning. Crons keep firing until the file is repaired. This protection applies to reloads only — an empty file at initial `start()` produces an empty schedule normally.
- You can verify the file is valid JSON: `cat "${CTX_ROOT}/state/{agent}/crons.json" | python3 -m json.tool`

**Disk full (ENOSPC / EACCES) during tick:**
- If `updateCron()` fails when persisting `last_fired_at` after a successful fire (e.g. disk full or read-only filesystem), the error is caught and logged to stderr. The in-memory schedule is kept intact and crons continue firing. State (`last_fired_at`, `fire_count`) will not be persisted until the write succeeds, so it may be lost if the daemon restarts before disk space is recovered.

**Need to revert:**
- Delete `${CTX_ROOT}/state/{agent}/crons.json` and `${CTX_ROOT}/state/{agent}/.crons-migrated`.
- The daemon will re-migrate from `config.json` on next start.
- Adding crons back via CronCreate is not recommended — session-local crons are unreliable.

---

## Backward Compatibility

- Existing `config.json` crons are unchanged. The daemon reads from `crons.json` only after migration.
- Bus commands (`add-cron`, `list-crons`, `remove-cron`, etc.) operate on `crons.json` directly.
- If you delete `.crons-migrated` and re-run, migration re-imports from `config.json`.
- New crons should be added via `cortextos bus add-cron`, not edited in `config.json` directly.
- Syntax: `cortextos bus add-cron <agent> <name> <interval|cron-expr> <prompt...>`

---

---

## Dashboard (Phase 4)

The web dashboard exposes a dedicated Workflows section for managing and monitoring crons:

| Route | Purpose |
|-------|---------|
| `/workflows` | Fleet overview — health summary panel + read-only cron table (all agents) |
| `/workflows/health` | Dedicated fleet health page with gap detection across all crons |
| `/workflows/[agent]/[name]` | Cron detail page — edit form, execution history, test-fire button |
| `/workflows/new` | Create new cron for any agent |

**Test-Fire button:** Each cron detail page has a "Test Fire" button that injects the cron's prompt into the agent immediately. A confirmation dialog is shown before firing. A 30-second cooldown prevents accidental rapid-fire (enforced both client-side and server-side via IPC `fire-cron`). After a successful fire the execution history auto-refreshes after 6 seconds.

**`manualFireDisabled` flag:** Setting `manualFireDisabled: true` on a cron definition disables the test-fire button and returns HTTP 403 from the API. Use this for crons that must only fire on schedule (e.g. financial reports, external API calls with rate limits). Operators can set this field via `cortextos bus update-cron` or the cron edit form.

**Execution history:** The detail page shows paginated execution history (100 entries/page) with status filter (All / Success / Failure) and CSV/JSON export. Columns: Timestamp, Status (success/retried/failed), Duration, Error.

**Fleet health caching:** The `/api/workflows/health` endpoint caches results for 30 seconds to avoid hammering disk on rapid dashboard polls. The cache is invalidated after any cron mutation (add/update/remove/fire).

---

## Architecture Reference

| Concern | File |
|---------|------|
| Cron schema | `src/types/index.ts` (`CronDefinition`) |
| File I/O | `src/bus/crons.ts` (`readCrons` with `.bak` fallback, `writeCrons` with `keepBak: true`) |
| Atomic write + `.bak` | `src/utils/atomic.ts` (`atomicWriteSync(path, data, keepBak)`) |
| Daemon scheduler | `src/daemon/cron-scheduler.ts` (`lastGoodSchedule`, ENOSPC catch in `tick()`) |
| IPC mutation handlers | `src/daemon/ipc-server.ts` (`handleAddCron`, `handleUpdateCron`, `handleRemoveCron`, `handleFireCron`) |
| Fleet health | `src/daemon/ipc-server.ts` (`computeFleetHealth`, 30s cache + invalidation) |
| Bus commands | `src/cli/bus.ts` (search `add-cron`, `list-crons`) |
| Migration logic | `src/daemon/cron-migration.ts` |
| Execution logging | `src/daemon/cron-execution-log.ts` |
| Dashboard — fleet overview | `dashboard/src/app/(dashboard)/workflows/page.tsx` |
| Dashboard — cron detail | `dashboard/src/app/(dashboard)/workflows/[agent]/[name]/page.tsx` |
| Dashboard — health page | `dashboard/src/app/(dashboard)/workflows/health/page.tsx` |
| Dashboard — test-fire button | `dashboard/src/components/workflows/test-fire-button.tsx` |
| Dashboard — execution history | `dashboard/src/components/workflows/cron-history.tsx` |
| API — fleet list | `dashboard/src/app/api/workflows/crons/route.ts` (GET/POST) |
| API — cron detail | `dashboard/src/app/api/workflows/crons/[agent]/[name]/route.ts` (PATCH/DELETE) |
| API — execution log | `dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route.ts` |
| API — manual fire | `dashboard/src/app/api/workflows/crons/[agent]/[name]/fire/route.ts` |
| API — fleet health | `dashboard/src/app/api/workflows/health/route.ts` |
