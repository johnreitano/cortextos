/**
 * cron-scheduler.ts — Daemon Cron Scheduling Engine (Subtask 1.3).
 *
 * The CronScheduler class is instantiated once by the daemon and ticks every
 * 30 seconds.  On each tick it checks which external crons are due and calls
 * the caller-supplied `onFire` callback for each one.
 *
 * CATCH-UP POLICY
 * ---------------
 * If the daemon was stopped and a cron's computed nextFireAt is in the past
 * on start(), we fire ONCE for the most recent missed window, then advance
 * nextFireAt to the next future slot.  We deliberately do not flood-fire all
 * missed windows — one catch-up is enough to inform the agent that time has
 * passed, and the agent can decide whether further action is needed.
 *
 * RETRY POLICY
 * ------------
 * 3 attempts with exponential backoff (1s → 4s → 16s).  If all 3 fail the
 * error is logged and the scheduler moves on — it does NOT crash.
 *
 * RELOAD SEMANTICS
 * ----------------
 * reload() re-reads crons.json.  For crons whose name + schedule string are
 * unchanged the in-memory nextFireAt is preserved so we don't reset timers.
 * New or modified crons get a freshly computed nextFireAt.
 */

import { parseDurationMs } from '../bus/cron-state.js';
import { readCrons, updateCron } from '../bus/crons.js';
import type { CronDefinition } from '../types/index.js';

// ---------------------------------------------------------------------------
// Cron expression parser — no external deps.
// Supports: *, */N, comma-lists, and ranges for each of the 5 standard fields.
// Fields: minute hour dom month dow (day-of-week: 0=Sunday … 6=Saturday).
// ---------------------------------------------------------------------------

/**
 * Expand a single cron field string into the set of matching integers.
 *
 * @param field - Raw field token (e.g. "*", "*\/5", "0,15,30,45", "1-5").
 * @param min   - Minimum valid value for this field (0 or 1).
 * @param max   - Maximum valid value (e.g. 59, 23, 31, 12, 6).
 */
function expandField(field: string, min: number, max: number): number[] {
  const result = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);
      for (let i = min; i <= max; i += step) result.add(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
      if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error(`Invalid cron range: ${part}`);
      for (let i = lo; i <= hi; i++) result.add(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) throw new Error(`Invalid cron value: ${part}`);
      result.add(n);
    }
  }

  return [...result].sort((a, b) => a - b);
}

/**
 * Compute the next fire timestamp (ms since epoch) for a 5-field cron
 * expression, starting from `fromMs` (exclusive — the next fire must be
 * strictly after fromMs, rounded forward to the next whole minute).
 *
 * @param expr   - 5-field cron expression ("min hour dom month dow").
 * @param fromMs - Starting epoch time in milliseconds.
 * @returns      Epoch ms of the next matching minute, or NaN if unparseable.
 */
export function nextFireFromCron(expr: string, fromMs: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return NaN;

  let [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  let minutes: number[], hours: number[], doms: number[], months: number[], dows: number[];
  try {
    minutes = expandField(minuteStr, 0, 59);
    hours   = expandField(hourStr,   0, 23);
    doms    = expandField(domStr,    1, 31);
    months  = expandField(monthStr,  1, 12);
    dows    = expandField(dowStr,    0, 6);
  } catch {
    return NaN;
  }

  // Start from the next whole minute after fromMs
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;

  // Walk forward minute-by-minute (capped at 1 year to avoid infinite loops).
  const MAX_MINUTES = 366 * 24 * 60;
  let candidate = startMs;

  for (let i = 0; i < MAX_MINUTES; i++) {
    const d = new Date(candidate);
    const m  = d.getMinutes();
    const h  = d.getHours();
    const dy = d.getDate();
    const mo = d.getMonth() + 1; // 1-12
    const dw = d.getDay();       // 0-6

    if (
      months.includes(mo) &&
      doms.includes(dy) &&
      dows.includes(dw) &&
      hours.includes(h) &&
      minutes.includes(m)
    ) {
      return candidate;
    }

    candidate += 60_000;
  }

  return NaN; // should never reach here for valid expressions
}

// ---------------------------------------------------------------------------
// Internal scheduler state for a single cron
// ---------------------------------------------------------------------------

interface ScheduledCron {
  definition: CronDefinition;
  /** Epoch ms when this cron should next fire. */
  nextFireAt: number;
  /** Normalised key for detecting definition changes: name|schedule */
  changeKey: string;
  /** True while onFire (+ retries) is executing — prevents re-entry on the next tick. */
  firing?: boolean;
}

function changeKeyFor(c: CronDefinition): string {
  return `${c.name}|${c.schedule}`;
}

/**
 * Compute the next fire time for a cron definition.
 *
 * For interval shorthands ("6h", "30m") we count forward from the
 * reference time.  For cron expressions we call nextFireFromCron().
 *
 * @param cron        - The cron definition.
 * @param referenceMs - Epoch ms to count forward from (usually now or lastFiredAt).
 */
function computeNextFireAt(cron: CronDefinition, referenceMs: number): number {
  const durationMs = parseDurationMs(cron.schedule);
  if (!isNaN(durationMs)) {
    return referenceMs + durationMs;
  }
  // Try as a cron expression
  const next = nextFireFromCron(cron.schedule, referenceMs);
  return next;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

async function fireWithRetry(
  cron: CronDefinition,
  onFire: (c: CronDefinition) => Promise<void> | void,
  logger: (msg: string) => void,
): Promise<boolean> {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      await Promise.resolve(onFire(cron));
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger(
          `[cron-scheduler] onFire failed for "${cron.name}" ` +
          `(attempt ${attempt + 1}/4, retrying in ${delay}ms): ${errMsg}`
        );
        await sleep(delay);
      } else {
        logger(
          `[cron-scheduler] onFire failed for "${cron.name}" ` +
          `after all 4 attempts — giving up. Last error: ${errMsg}`
        );
      }
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

export interface CronSchedulerOptions {
  agentName: string;
  onFire: (cron: CronDefinition) => Promise<void> | void;
  logger?: (msg: string) => void;
}

export class CronScheduler {
  private readonly agentName: string;
  private readonly onFire: (cron: CronDefinition) => Promise<void> | void;
  private readonly logger: (msg: string) => void;

  /** In-memory schedule, keyed by cron name. */
  private scheduled: Map<string, ScheduledCron> = new Map();

  /** The master 30-second interval handle. */
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** Epoch ms of the tick interval, exposed so tests can override. */
  static readonly TICK_INTERVAL_MS = 30_000;

  constructor(opts: CronSchedulerOptions) {
    this.agentName = opts.agentName;
    this.onFire    = opts.onFire;
    this.logger    = opts.logger ?? ((msg: string) => process.stdout.write(msg + '\n'));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the scheduler.  Reads crons.json, builds in-memory schedule, and
   * begins the master tick loop.
   */
  start(): void {
    if (this.tickHandle !== null) {
      this.logger('[cron-scheduler] start() called while already running — ignored');
      return;
    }
    this.loadCrons(/* isReload */ false);
    this.tickHandle = setInterval(() => void this.tick(), CronScheduler.TICK_INTERVAL_MS);
    this.logger(`[cron-scheduler] started for agent "${this.agentName}" with ${this.scheduled.size} cron(s)`);
  }

  /**
   * Stop the scheduler and clear all timers.
   */
  stop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.scheduled.clear();
    this.logger(`[cron-scheduler] stopped for agent "${this.agentName}"`);
  }

  /**
   * Re-read crons.json and update the in-memory schedule.
   *
   * Crons whose name + schedule are unchanged retain their current nextFireAt
   * so we don't accidentally reset pending timers.  New or modified crons get
   * a freshly computed nextFireAt.
   */
  reload(): void {
    this.loadCrons(/* isReload */ true);
    this.logger(`[cron-scheduler] reloaded for agent "${this.agentName}" — ${this.scheduled.size} cron(s) active`);
  }

  /**
   * Return the next fire time for every scheduled cron (for CLI/debugging).
   */
  getNextFireTimes(): Array<{ name: string; nextFireAt: number }> {
    return [...this.scheduled.values()].map(sc => ({
      name: sc.definition.name,
      nextFireAt: sc.nextFireAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private loadCrons(isReload: boolean): void {
    const now = Date.now();
    const defs = readCrons(this.agentName);
    const nextScheduled = new Map<string, ScheduledCron>();

    for (const def of defs) {
      if (!def.enabled) {
        // Disabled — silently skip
        continue;
      }

      const key = changeKeyFor(def);
      const existing = this.scheduled.get(def.name);

      if (isReload && existing !== undefined && existing.changeKey === key) {
        // Definition unchanged — preserve nextFireAt
        nextScheduled.set(def.name, { ...existing, definition: def });
        continue;
      }

      // New or modified cron — compute fresh nextFireAt.
      // Base: if the cron has a recorded last_fired_at, count forward from there;
      // otherwise count forward from now.
      const referenceMs = def.last_fired_at
        ? new Date(def.last_fired_at).getTime()
        : now;

      let nextFireAt = computeNextFireAt(def, referenceMs);

      if (isNaN(nextFireAt)) {
        this.logger(
          `[cron-scheduler] WARNING: cannot parse schedule "${def.schedule}" for cron "${def.name}" — skipping`
        );
        continue;
      }

      // CATCH-UP POLICY: if nextFireAt is in the past (daemon was stopped),
      // fire once immediately for the missed window, then recompute from now.
      // We do NOT flood-fire all missed windows — one catch-up is sufficient.
      if (nextFireAt <= now) {
        this.logger(
          `[cron-scheduler] catch-up: cron "${def.name}" missed fire at ${new Date(nextFireAt).toISOString()} — scheduling immediate fire`
        );
        nextFireAt = now; // fire on the very next tick
      }

      nextScheduled.set(def.name, { definition: def, nextFireAt, changeKey: key });
    }

    this.scheduled = nextScheduled;
  }

  private async tick(): Promise<void> {
    const now = Date.now();

    for (const [name, sc] of this.scheduled) {
      if (sc.nextFireAt > now) {
        continue; // not yet due
      }

      // Guard against re-entry: if a previous tick's async fire+retry is still
      // in flight (can happen with fake timers or very slow onFire), skip.
      if (sc.firing) {
        continue;
      }

      sc.firing = true;
      const cron = sc.definition;
      this.logger(`[cron-scheduler] firing cron "${name}" (was due ${new Date(sc.nextFireAt).toISOString()})`);

      const success = await fireWithRetry(cron, this.onFire, this.logger);

      if (success) {
        // Persist last_fired_at + fire_count to disk
        const nowIso = new Date(now).toISOString();
        const newFireCount = (cron.fire_count ?? 0) + 1;
        updateCron(this.agentName, name, {
          last_fired_at: nowIso,
          fire_count: newFireCount,
        });

        // Advance in-memory nextFireAt
        const next = computeNextFireAt(cron, now);
        if (!isNaN(next)) {
          sc.nextFireAt = next;
          sc.definition = { ...cron, last_fired_at: nowIso, fire_count: newFireCount };
        } else {
          // Unrecognised schedule after fire — remove from schedule to avoid infinite loops
          this.scheduled.delete(name);
          this.logger(`[cron-scheduler] WARNING: removed "${name}" from schedule after fire — schedule unparseable`);
          continue; // sc is gone, skip clearing firing flag
        }
      }
      // If not successful, keep existing nextFireAt so we retry next tick
      sc.firing = false;
    }
  }
}
