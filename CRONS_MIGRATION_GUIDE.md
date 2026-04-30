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
- If `crons.json` is corrupt (parse error) or was accidentally emptied, the daemon silently treats it as empty and logs a warning to stderr.
- Fix: delete the malformed file and re-run `cortextos bus migrate-crons <agent> --force` to regenerate from `config.json`, or write a new `crons.json` using `cortextos bus add-cron`.
- You can verify the file is valid JSON: `cat "${CTX_ROOT}/state/{agent}/crons.json" | python3 -m json.tool`

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

## Architecture Reference

| Concern | File |
|---------|------|
| Cron schema | `src/types/index.ts` (`CronDefinition`) |
| File I/O | `src/bus/crons.ts` |
| Daemon scheduler | `src/daemon/cron-scheduler.ts` |
| Bus commands | `src/cli/bus.ts` (search `add-cron`, `list-crons`) |
| Migration logic | `src/daemon/cron-migration.ts` |
| Execution logging | `src/daemon/cron-execution-log.ts` |
