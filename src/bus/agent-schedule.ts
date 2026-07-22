// Day/night schedule resolution — the ONE place that answers "what timezone and
// what day-window does this agent run on, and is it day or night right now?"
//
// WHY THIS MODULE EXISTS (2026-07-22 incident): the heartbeat writer computed
// day/night from a hardcoded 'UTC' literal and a hardcoded 08:00-22:00 window,
// while the configured intent lived in context.json / config.json and was read
// only by `bus get-config` — a command nothing on this path called. Two
// declarations of the same rule, one of them unreachable, so every agent's
// heartbeat carried a mode computed against the wrong zone AND the wrong window.
//
// The modes are not cosmetic: SOUL.md gives them OPPOSITE standing orders (night
// says "idle is failure, find new tasks proactively, no external comms"). A wrong
// mode is a wrong instruction, so this resolution is behavioural, not display.
//
// ★ WHAT IS MEASURED vs WHAT IS NOT — do not let this drift into a damage claim.
// MEASURED and certain: the structural defect. The configured timezone and window
// were unreachable on this path, and the shipped constants disagree with the
// configured intent for 8.5-10.5 hours a day depending on the agent.
// NOT ESTABLISHED: that the wrong flag actually changed behaviour. The
// comms-suppression half was TESTED against 7 days of events and REFUTED — the
// single highest comms hour of the day sits inside the wrongly-night band, so
// suppression did not happen. The "manufactures work at night" half is untested,
// not confirmed. This fix is justified by the structural defect alone, which is
// sufficient; it does not depend on the behavioural harm, and nobody should cite
// it as evidence of harm. (This is also why the caller now logs `mode` on every
// heartbeat: until then the flag left no history, so questions about its effect
// could only be answered by inference from config plus code.)
//
// Everything that needs the schedule resolves it HERE. Do not re-read
// context.json or re-derive a window at a call site — that is how the original
// defect happened.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { stripBom } from '../utils/strip-bom.js';

/** Framework defaults, matching what `cortextos init` writes into a new config.
 *  Kept identical to src/cli/init.ts and the get-config fallbacks on purpose: a
 *  third set of defaults is another rule that can drift. */
export const DEFAULT_TIMEZONE = 'UTC';
export const DEFAULT_DAY_START = '08:00';
export const DEFAULT_DAY_END = '00:00';

export interface AgentSchedule {
  timezone: string;
  dayStart: string;
  dayEnd: string;
}

/** "HH:MM" -> minutes since local midnight. Returns null if unparseable, so a
 *  malformed config surfaces as a visible fallback rather than NaN arithmetic
 *  that silently classifies everything as night. */
export function parseHhMm(value: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Resolve timezone + day window for an agent: agent config overrides org
 * context, org context overrides framework defaults.
 *
 * PATH RESOLUTION follows the rule established in bus/approval.ts after the
 * activity-channel incident: config lives under the FRAMEWORK root, NOT the
 * runtime state root (paths.ctxRoot). Chain is explicit arg ->
 * CTX_FRAMEWORK_ROOT -> process.cwd(). We deliberately do NOT fall back to
 * ctxRoot: silently reading a known-wrong path is worse than using declared
 * defaults, because it produces a confident answer from the wrong file.
 *
 * Unreadable/absent config is NOT an error — a fresh install has neither — so
 * this returns defaults rather than throwing. Malformed JSON warns, matching
 * get-config, so misconfiguration is visible instead of silently defaulted.
 */
export function resolveAgentSchedule(
  org: string,
  agentName: string,
  frameworkRoot?: string,
): AgentSchedule {
  const root = frameworkRoot || process.env.CTX_FRAMEWORK_ROOT || process.cwd();

  const readJson = (path: string): Record<string, unknown> => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(stripBom(readFileSync(path, 'utf-8')));
    } catch (err) {
      process.stderr.write(
        `Warning: failed to parse ${path} (${(err as Error).message}); using defaults for day/night schedule\n`,
      );
      return {};
    }
  };

  const orgCtx = org ? readJson(join(root, 'orgs', org, 'context.json')) : {};
  const agentCfg =
    org && agentName ? readJson(join(root, 'orgs', org, 'agents', agentName, 'config.json')) : {};

  const pick = (key: string, fallback: string): string => {
    const a = agentCfg[key];
    const o = orgCtx[key];
    if (typeof a === 'string' && a.trim()) return a;
    if (typeof o === 'string' && o.trim()) return o;
    return fallback;
  };

  return {
    timezone: pick('timezone', DEFAULT_TIMEZONE),
    dayStart: pick('day_mode_start', DEFAULT_DAY_START),
    dayEnd: pick('day_mode_end', DEFAULT_DAY_END),
  };
}

/** Current wall-clock minutes-since-midnight in `timezone`, or null if the zone
 *  is not one Intl recognizes. */
function minutesNowIn(timezone: string): number | null {
  try {
    const parts = new Date()
      .toLocaleString('en-US', {
        timeZone: timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      })
      .trim();
    // en-US 24h formatting renders midnight as "24:MM" in some ICU versions.
    const m = /(\d{1,2}):(\d{2})/.exec(parts);
    if (!m) return null;
    return (Number(m[1]) % 24) * 60 + Number(m[2]);
  } catch {
    return null;
  }
}

/**
 * Is `minutes` inside the day window [start, end)?
 *
 * The window WRAPS when end <= start, which is the normal case for the shipped
 * default (08:00-00:00): midnight-as-end means "until end of day", so the naive
 * `start <= x && x < end` test would classify the entire day as night. An
 * earlier version of this logic hardcoded 8-22 and never had to handle the wrap,
 * which is why the default window and the code disagreed.
 *
 * start === end is treated as ALWAYS DAY (a zero-length night), matching the
 * intuition that "day starts and ends at the same moment" means no night, and
 * avoiding a config typo silently putting an agent in permanent night mode —
 * night carries the more aggressive standing orders, so the safer failure is day.
 */
export function isWithinDayWindow(minutes: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

/**
 * Detect day/night for a resolved schedule.
 *
 * Falls back to the framework default WINDOW (not to a hardcoded 8-22) when the
 * configured times are unparseable, and to UTC when the timezone is unknown —
 * each fallback warns, because a silently-wrong mode is a silently-wrong
 * standing order.
 */
export function detectDayNightMode(
  timezone: string,
  dayStart: string = DEFAULT_DAY_START,
  dayEnd: string = DEFAULT_DAY_END,
): 'day' | 'night' {
  let startMin = parseHhMm(dayStart);
  let endMin = parseHhMm(dayEnd);
  if (startMin === null || endMin === null) {
    process.stderr.write(
      `Warning: unparseable day window (${dayStart}-${dayEnd}); falling back to ${DEFAULT_DAY_START}-${DEFAULT_DAY_END}\n`,
    );
    startMin = parseHhMm(DEFAULT_DAY_START)!;
    endMin = parseHhMm(DEFAULT_DAY_END)!;
  }

  let minutes = minutesNowIn(timezone);
  if (minutes === null) {
    process.stderr.write(`Warning: unknown timezone "${timezone}"; falling back to UTC\n`);
    const now = new Date();
    minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  return isWithinDayWindow(minutes, startMin, endMin) ? 'day' : 'night';
}
