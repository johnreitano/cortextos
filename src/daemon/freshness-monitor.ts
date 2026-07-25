// Cross-agent heartbeat-freshness monitor — the fix for the 2026-07-24 blind spot
// where two agents sat WEDGED (process alive, session stuck on a resume/permission
// screen, crons injected but never processed) for ~40h while `cortextos status`
// and the watchdog reported both "running/alive". Root cause: the watchdog keyed
// on PID existence, and PID-alive ≠ processing.
//
// DETECTION (analyst-owned signal spec, co-owned task): key on heartbeat.json
// FRESHNESS, not the PID and not the read-all-heartbeats "[STALE]" label — both
// of those are banked-unreliable. Compute the age ourselves from the
// `last_heartbeat` ISO timestamp in UTC and compare it to a threshold RELATIVE to
// each agent's own heartbeat-cron interval.
//
// THREE STATES the old watchdog collapsed:
//   1. PID dead                     → CRASHED  (owned by the crash-alert path; not us)
//   2. PID alive, age ≤ wedged      → HEALTHY
//   3. PID alive, age >  wedged     → WEDGED   ← the missed state, our new alert
//                    age > escalate → ESCALATE (likely needs a restart)
//
// PLACEMENT (why this is a daemon module, not agent code): the check that catches
// a stalled agent must not live inside an agent that can itself stall — the
// orchestrator was the stalled one in the incident. The daemon is the only
// always-live cross-agent vantage.
//
// This file is the PURE classifier + parsing (dependency-free, unit-tested). The
// IO — reading each agent's heartbeat.json + crons.json, the periodic sweep, the
// operator Telegram — is wired in the Daemon (see runFreshnessSweep).

/** Interval source note: heartbeat.json's `loop_interval` is EMPTY for every
 *  agent (the heartbeat crons + the fast-checker idle-watchdog call
 *  update-heartbeat without --interval), so the per-agent interval is read from
 *  the agent's crons.json heartbeat cron instead — verified authoritative. */

export type FreshnessState = 'crashed' | 'healthy' | 'wedged' | 'escalate';

export interface FreshnessThresholds {
  /** WEDGED when age > this × interval … */
  wedgedMultiplier: number;
  /** … but never below this floor (stops a short-interval agent alerting on jitter). */
  wedgedFloorMs: number;
  /** ESCALATE when age > max(escalateFloorMs, escalateMultiplier × interval). */
  escalateMultiplier: number;
  escalateFloorMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Default thresholds — analyst-confirmed (task_1784908405771):
 *   WEDGED (notify)   = age > max(2.5 × interval, 30-min floor)  → 4h loop ⇒ 10h
 *   ESCALATE (restart)= age > max(4 × interval, 6h floor)        → 4h loop ⇒ 16h
 * 2.5× not 1× because one legitimately-missed beat + jitter must not fire; the
 * floor stops a short-interval agent alerting on normal variance.
 *
 * ★ DETECTION LATENCY IS INTERVAL-BOUND, not threshold-bound: a 4h agent only
 * proves its loop progressed every 4h, so a wedge cannot be confirmed faster
 * than ~2 missed beats (~10h) at ANY threshold — "you cannot measure faster than
 * you sample." The fast-checker's frequent "[watchdog] alive" beat does not help:
 * it proves the PID/session is alive, which is exactly TRUE during a wedge. To
 * catch wedges faster, shorten the heartbeat interval (or add a loop-progress
 * ping distinct from the PID ping) — a tighter threshold cannot do it.
 */
export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  wedgedMultiplier: 2.5,
  wedgedFloorMs: 30 * MIN,
  escalateMultiplier: 4,
  escalateFloorMs: 6 * HOUR,
};

export interface FreshnessInput {
  /** Does the daemon see the agent's process/PTY as alive? */
  pidAlive: boolean;
  /** now − last_heartbeat, in ms. */
  ageMs: number;
  /** The agent's heartbeat-cron interval in ms (from crons.json). */
  intervalMs: number;
  /** A planned-restart / daemon-stop / session-refresh lifecycle marker is
   *  present — the pause is intentional, so WEDGED must be suppressed (the
   *  inverse failure of the bug: alerting on a deliberate pause). */
  lifecyclePaused: boolean;
}

export interface FreshnessVerdict {
  state: FreshnessState;
  reason: string;
}

/** Parse a cron interval string ("4h", "30m", "90s", "2h30m") to ms. Returns
 *  null if unparseable, so the caller can fall back rather than compute against
 *  NaN (which would make every agent look wedged or healthy at random). */
export function parseIntervalMs(interval: string | undefined | null): number | null {
  if (!interval) return null;
  const s = String(interval).trim().toLowerCase();
  const re = /(\d+)\s*([hms])/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += n * (m[2] === 'h' ? HOUR : m[2] === 'm' ? MIN : 1000);
  }
  return matched ? total : null;
}

/** Age in ms from an ISO `last_heartbeat` to `nowMs`. Returns null if the
 *  timestamp is missing/unparseable — an agent with no readable heartbeat is a
 *  distinct problem the caller decides how to treat, not silently age 0. */
export function heartbeatAgeMs(lastHeartbeatIso: string | undefined | null, nowMs: number): number | null {
  if (!lastHeartbeatIso) return null;
  const t = Date.parse(lastHeartbeatIso);
  if (Number.isNaN(t)) return null;
  return nowMs - t;
}

/**
 * Classify one agent's liveness. Pure: all inputs are values, no IO.
 *
 * Order matters: a dead PID is CRASHED regardless of age (the crash path owns
 * it); an intentional pause is HEALTHY regardless of age (suppression guard);
 * only a live, non-paused, stale agent is WEDGED/ESCALATE.
 */
export function classifyFreshness(
  input: FreshnessInput,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): FreshnessVerdict {
  if (!input.pidAlive) {
    return { state: 'crashed', reason: 'process not alive (crash-alert path owns this)' };
  }
  if (input.lifecyclePaused) {
    return { state: 'healthy', reason: 'planned lifecycle pause — wedged suppressed' };
  }

  const wedgedAt = Math.max(thresholds.wedgedMultiplier * input.intervalMs, thresholds.wedgedFloorMs);
  const escalateAt = Math.max(thresholds.escalateFloorMs, thresholds.escalateMultiplier * input.intervalMs);

  const ageMin = Math.round(input.ageMs / MIN);
  if (input.ageMs > escalateAt) {
    return { state: 'escalate', reason: `heartbeat ${ageMin}m stale (> escalate ${Math.round(escalateAt / MIN)}m) — likely needs restart` };
  }
  if (input.ageMs > wedgedAt) {
    return { state: 'wedged', reason: `heartbeat ${ageMin}m stale (> wedged ${Math.round(wedgedAt / MIN)}m) but process alive` };
  }
  return { state: 'healthy', reason: `heartbeat ${ageMin}m fresh` };
}

// ─── IO layer: sweep, readers, cooldown (kept dependency-injectable for tests) ──

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { END_TYPE_MARKERS } from '../bus/heartbeat.js';

/** Lifecycle markers that mean an INTENTIONAL pause → suppress WEDGED. Derived
 *  from the authoritative END_TYPE_MARKERS so a new intentional-stop marker flows
 *  in automatically, MINUS .daemon-crashed (analyst call): a crash is a FAULT not
 *  an intent. While the crash is current, PID-dead already routes to CRASHED and
 *  WEDGED can't fire; the only case the suppressor would bite is a STALE
 *  crash-marker on a restarted-and-running agent, where it would MASK a real
 *  wedge. So it must not suppress. */
export const LIFECYCLE_PAUSE_MARKERS = END_TYPE_MARKERS.filter((m) => m !== '.daemon-crashed');

/** Fleet-norm fallback when an agent has no parseable heartbeat cron interval. */
export const FALLBACK_INTERVAL_MS = 4 * HOUR;

/** The cron whose interval sets an agent's heartbeat cadence. */
const HEARTBEAT_CRON_NAME = 'heartbeat';

export interface AgentLiveness {
  name: string;
  /** Daemon sees the process/PTY as alive (AgentStatus.status === 'running'). */
  pidAlive: boolean;
  /** {ctxRoot}/state/{agent} — holds heartbeat.json, crons.json, lifecycle markers. */
  stateDir: string;
}

/** Readers are injected so the sweep is unit-testable without a filesystem. */
export interface FreshnessReaders {
  readLastHeartbeat: (stateDir: string) => string | null;
  readIntervalMs: (stateDir: string) => number | null;
  isLifecyclePaused: (stateDir: string) => boolean;
}

export interface AgentVerdict extends FreshnessVerdict {
  name: string;
  ageMs: number | null;
}

/** Real filesystem readers for the daemon. */
export const fsReaders: FreshnessReaders = {
  readLastHeartbeat(stateDir) {
    try {
      const hb = JSON.parse(readFileSync(join(stateDir, 'heartbeat.json'), 'utf-8'));
      return typeof hb.last_heartbeat === 'string' ? hb.last_heartbeat : null;
    } catch {
      return null;
    }
  },
  readIntervalMs(stateDir) {
    try {
      const raw = JSON.parse(readFileSync(join(stateDir, 'crons.json'), 'utf-8'));
      const crons = Array.isArray(raw) ? raw : Array.isArray(raw?.crons) ? raw.crons : [];
      const hb = crons.find((c: { name?: string }) => c?.name === HEARTBEAT_CRON_NAME) ?? crons[0];
      return parseIntervalMs(hb?.interval ?? hb?.schedule);
    } catch {
      return null;
    }
  },
  isLifecyclePaused(stateDir) {
    return LIFECYCLE_PAUSE_MARKERS.some((m) => existsSync(join(stateDir, m)));
  },
};

/**
 * Classify every agent. A running agent whose heartbeat timestamp is unreadable
 * is reported 'healthy' with a note rather than alerted — a just-started agent
 * may not have written its first heartbeat, and the incident's signature was a
 * PRESENT-but-stale heartbeat, not a missing one. Missing-file is logged by the
 * caller, not escalated, to avoid false-firing on startup.
 */
export function sweepAgents(
  agents: AgentLiveness[],
  readers: FreshnessReaders,
  nowMs: number,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): AgentVerdict[] {
  return agents.map((a) => {
    if (!a.pidAlive) {
      return { name: a.name, state: 'crashed', reason: 'process not alive', ageMs: null };
    }
    const iso = readers.readLastHeartbeat(a.stateDir);
    const ageMs = heartbeatAgeMs(iso, nowMs);
    if (ageMs === null) {
      return { name: a.name, state: 'healthy', reason: 'no readable heartbeat yet — not assessed', ageMs: null };
    }
    const intervalMs = readers.readIntervalMs(a.stateDir) ?? FALLBACK_INTERVAL_MS;
    const v = classifyFreshness(
      { pidAlive: true, ageMs, intervalMs, lifecyclePaused: readers.isLifecyclePaused(a.stateDir) },
      thresholds,
    );
    return { name: a.name, state: v.state, reason: v.reason, ageMs };
  });
}

/**
 * Decide whether to alert for a verdict, given the last alert sent for that
 * agent. Alerts fire on entering wedged/escalate, re-fire when the state
 * WORSENS (wedged → escalate), and otherwise re-fire only after a cooldown so a
 * persistent wedge nags periodically instead of every sweep. Pure.
 */
export function shouldAlert(
  verdict: AgentVerdict,
  last: { state: FreshnessState; atMs: number } | undefined,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (verdict.state !== 'wedged' && verdict.state !== 'escalate') return false;
  if (!last) return true;
  if (verdict.state !== last.state) return true; // transition (incl. wedged→escalate)
  return nowMs - last.atMs >= cooldownMs;
}

