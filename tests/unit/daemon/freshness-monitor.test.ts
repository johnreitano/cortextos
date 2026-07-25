// Cross-agent heartbeat-freshness classifier (src/daemon/freshness-monitor.ts).
//
// The headline cases are the analyst's falsification spec (task_1784908405771):
//   - a live process with a frozen heartbeat flips HEALTHY → WEDGED at the
//     threshold (the state the old PID-only watchdog could never reach), and
//   - a planned lifecycle pause does NOT fire WEDGED (the inverse failure — the
//     bug we fix must not become "alert on every deliberate restart").
// A fix that only passed the healthy case would be green-covering-nothing.

import { describe, test, expect } from 'vitest';
import {
  classifyFreshness,
  parseIntervalMs,
  heartbeatAgeMs,
  sweepAgents,
  shouldAlert,
  LIFECYCLE_PAUSE_MARKERS,
  DEFAULT_THRESHOLDS,
  type FreshnessInput,
  type FreshnessReaders,
  type AgentLiveness,
  type AgentVerdict,
} from '../../../src/daemon/freshness-monitor.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const FOUR_H = 4 * HOUR;

const input = (o: Partial<FreshnessInput>): FreshnessInput => ({
  pidAlive: true,
  ageMs: 0,
  intervalMs: FOUR_H,
  lifecyclePaused: false,
  ...o,
});

describe('parseIntervalMs', () => {
  test('parses h/m/s and compounds', () => {
    expect(parseIntervalMs('4h')).toBe(FOUR_H);
    expect(parseIntervalMs('30m')).toBe(30 * MIN);
    expect(parseIntervalMs('90s')).toBe(90_000);
    expect(parseIntervalMs('2h30m')).toBe(2 * HOUR + 30 * MIN);
  });

  test('returns null (not NaN) for unparseable input, so the caller can fall back', () => {
    for (const bad of ['', undefined, null, 'soon', 'cron(0 * * * *)']) {
      expect(parseIntervalMs(bad as string)).toBeNull();
    }
  });
});

describe('heartbeatAgeMs', () => {
  test('computes age from an ISO timestamp in UTC', () => {
    const now = Date.parse('2026-07-25T12:00:00Z');
    expect(heartbeatAgeMs('2026-07-25T02:00:00Z', now)).toBe(10 * HOUR);
  });
  test('null for a missing or unparseable timestamp (not silently 0)', () => {
    const now = Date.parse('2026-07-25T12:00:00Z');
    expect(heartbeatAgeMs(undefined, now)).toBeNull();
    expect(heartbeatAgeMs('not-a-date', now)).toBeNull();
  });
});

describe('classifyFreshness — the three states', () => {
  test('PID dead → CRASHED regardless of age (crash path owns it)', () => {
    expect(classifyFreshness(input({ pidAlive: false, ageMs: 0 })).state).toBe('crashed');
  });

  test('fresh heartbeat → HEALTHY', () => {
    expect(classifyFreshness(input({ ageMs: 1 * HOUR })).state).toBe('healthy');
  });

  // ★ the missed state: process alive but heartbeat frozen.
  test('live process, frozen heartbeat past 2.5× interval → WEDGED', () => {
    // 4h loop → wedged at 10h. 11h is past it, under the 16h escalate.
    expect(classifyFreshness(input({ ageMs: 11 * HOUR })).state).toBe('wedged');
  });

  test('further stale, past max(4× interval, 6h) → ESCALATE', () => {
    expect(classifyFreshness(input({ ageMs: 17 * HOUR })).state).toBe('escalate');
  });

  test('the 40h incident on a 4h loop → ESCALATE (was: never)', () => {
    expect(classifyFreshness(input({ ageMs: 40 * HOUR })).state).toBe('escalate');
  });
});

describe('classifyFreshness — boundaries (10h wedged / 16h escalate on a 4h loop)', () => {
  test('exactly at the wedged threshold is still healthy; just past it is wedged', () => {
    expect(classifyFreshness(input({ ageMs: 10 * HOUR })).state).toBe('healthy'); // > is strict
    expect(classifyFreshness(input({ ageMs: 10 * HOUR + MIN })).state).toBe('wedged');
  });
  test('exactly at the escalate threshold is still wedged; just past it escalates', () => {
    expect(classifyFreshness(input({ ageMs: 16 * HOUR })).state).toBe('wedged');
    expect(classifyFreshness(input({ ageMs: 16 * HOUR + MIN })).state).toBe('escalate');
  });
});

describe('classifyFreshness — floors protect short-interval agents', () => {
  test('a 5-min-interval agent does not wedge at 12.5min (2.5× = 12.5min < 30min floor)', () => {
    const fiveMin = 5 * MIN;
    expect(classifyFreshness(input({ intervalMs: fiveMin, ageMs: 20 * MIN })).state).toBe('healthy');
    // past the 30-min floor it does wedge
    expect(classifyFreshness(input({ intervalMs: fiveMin, ageMs: 31 * MIN })).state).toBe('wedged');
  });

  test('escalate floor is 6h even for a short interval', () => {
    const fiveMin = 5 * MIN;
    // 4× 5min = 20min, but the 6h floor dominates
    expect(classifyFreshness(input({ intervalMs: fiveMin, ageMs: 5 * HOUR })).state).toBe('wedged');
    expect(classifyFreshness(input({ intervalMs: fiveMin, ageMs: 6 * HOUR + MIN })).state).toBe('escalate');
  });
});

describe('★ lifecycle suppression — a planned pause must NOT read as wedged', () => {
  test('a stale heartbeat under a planned lifecycle marker is HEALTHY, not wedged', () => {
    expect(classifyFreshness(input({ ageMs: 40 * HOUR, lifecyclePaused: true })).state).toBe('healthy');
  });
});

describe('longer intervals scale the thresholds', () => {
  test('a 2h-loop agent wedges at 5h (2.5× 2h), not 10h', () => {
    expect(classifyFreshness(input({ intervalMs: 2 * HOUR, ageMs: 6 * HOUR })).state).toBe('wedged');
  });
  test('thresholds are overridable', () => {
    const strict = { ...DEFAULT_THRESHOLDS, wedgedMultiplier: 1, wedgedFloorMs: 0 };
    expect(classifyFreshness(input({ ageMs: 5 * HOUR }), strict).state).not.toBe('healthy');
  });
});

describe('LIFECYCLE_PAUSE_MARKERS', () => {
  test('includes the six intentional-stop markers and EXCLUDES .daemon-crashed', () => {
    expect(LIFECYCLE_PAUSE_MARKERS).toContain('.restart-planned');
    expect(LIFECYCLE_PAUSE_MARKERS).toContain('.user-stop');
    expect(LIFECYCLE_PAUSE_MARKERS).toContain('.daemon-stop');
    expect(LIFECYCLE_PAUSE_MARKERS).not.toContain('.daemon-crashed');
  });
});

describe('sweepAgents (injected readers — no filesystem)', () => {
  const NOW = Date.parse('2026-07-25T12:00:00Z');
  const iso = (hAgo: number) => new Date(NOW - hAgo * HOUR).toISOString();

  const readers = (over: Partial<Record<string, { hb: string | null; interval: number | null; paused: boolean }>>): FreshnessReaders => ({
    readLastHeartbeat: (d) => over[d]?.hb ?? null,
    readIntervalMs: (d) => over[d]?.interval ?? null,
    isLifecyclePaused: (d) => over[d]?.paused ?? false,
  });

  const agent = (name: string, pidAlive: boolean): AgentLiveness => ({ name, pidAlive, stateDir: name });

  test('classifies a fresh, a wedged, a crashed, and a paused agent in one sweep', () => {
    const agents = [
      agent('fresh', true),
      agent('wedged', true),
      agent('dead', false),
      agent('paused', true),
    ];
    const r = readers({
      fresh: { hb: iso(1), interval: 4 * HOUR, paused: false },
      wedged: { hb: iso(20), interval: 4 * HOUR, paused: false },
      paused: { hb: iso(40), interval: 4 * HOUR, paused: true },
    });
    const byName = Object.fromEntries(sweepAgents(agents, r, NOW).map((v) => [v.name, v.state]));
    expect(byName).toEqual({ fresh: 'healthy', wedged: 'escalate', dead: 'crashed', paused: 'healthy' });
  });

  test('falls back to the 4h interval when crons.json interval is unreadable', () => {
    // 11h stale, no interval → fallback 4h → wedged (>10h), not escalate (<16h).
    const agents = [agent('a', true)];
    const [v] = sweepAgents(agents, readers({ a: { hb: iso(11), interval: null, paused: false } }), NOW);
    expect(v.state).toBe('wedged');
  });

  test('a running agent with no readable heartbeat is not alerted (startup edge)', () => {
    const [v] = sweepAgents([agent('new', true)], readers({}), NOW);
    expect(v.state).toBe('healthy');
    expect(v.ageMs).toBeNull();
  });
});

describe('shouldAlert (transition + cooldown)', () => {
  const NOW = 1_000 * HOUR;
  const v = (state: AgentVerdict['state']): AgentVerdict => ({ name: 'x', state, reason: '', ageMs: 1 });

  test('healthy/crashed never alert', () => {
    expect(shouldAlert(v('healthy'), undefined, NOW, HOUR)).toBe(false);
    expect(shouldAlert(v('crashed'), undefined, NOW, HOUR)).toBe(false);
  });
  test('first wedged alerts', () => {
    expect(shouldAlert(v('wedged'), undefined, NOW, HOUR)).toBe(true);
  });
  test('wedged→escalate re-alerts immediately (state worsened)', () => {
    expect(shouldAlert(v('escalate'), { state: 'wedged', atMs: NOW }, NOW, 6 * HOUR)).toBe(true);
  });
  test('same state within cooldown is suppressed; past cooldown re-fires', () => {
    expect(shouldAlert(v('wedged'), { state: 'wedged', atMs: NOW - 1 * HOUR }, NOW, 6 * HOUR)).toBe(false);
    expect(shouldAlert(v('wedged'), { state: 'wedged', atMs: NOW - 7 * HOUR }, NOW, 6 * HOUR)).toBe(true);
  });
});
