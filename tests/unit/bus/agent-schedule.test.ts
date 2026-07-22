// Day/night schedule resolution (src/bus/agent-schedule.ts).
//
// The 2026-07-22 defect: the heartbeat writer computed mode from a hardcoded
// 'UTC' literal on a hardcoded 08:00-22:00 window, so config.json's timezone and
// day_mode_start/end were never read. Under leadio's configured intent
// (America/Los_Angeles, 05:30-19:00) that produced the WRONG MODE FOR 11 HOURS
// A DAY. The modes carry opposite standing orders in SOUL.md — night says "idle
// is failure, find new tasks proactively, no external comms" — so a wrong mode
// is a wrong instruction, not a wrong label.
//
// The divergence-band cases below are the regression guard: they assert the
// specific hours that were previously misclassified. A fix for only the timezone
// (leaving the window hardcoded) still fails the window cases, and vice versa —
// deliberately, because this ticket's own history is a partial remedy that
// shipped as a fix.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectDayNightMode,
  isWithinDayWindow,
  parseHhMm,
  resolveAgentSchedule,
  DEFAULT_DAY_START,
  DEFAULT_DAY_END,
} from '../../../src/bus/agent-schedule.js';

const HHMM = (h: number, m = 0) => h * 60 + m;

afterEach(() => {
  vi.useRealTimers();
});

/** Build a throwaway framework root with org + agent config. */
function fixtureRoot(org: string, agent: string, orgCfg: object, agentCfg?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sched-'));
  mkdirSync(join(root, 'orgs', org, 'agents', agent), { recursive: true });
  writeFileSync(join(root, 'orgs', org, 'context.json'), JSON.stringify(orgCfg));
  if (agentCfg) {
    writeFileSync(join(root, 'orgs', org, 'agents', agent, 'config.json'), JSON.stringify(agentCfg));
  }
  return root;
}

describe('parseHhMm', () => {
  test('parses valid times', () => {
    expect(parseHhMm('05:30')).toBe(HHMM(5, 30));
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm('23:59')).toBe(HHMM(23, 59));
  });

  test('rejects malformed and out-of-range values rather than returning NaN', () => {
    // NaN arithmetic downstream would silently classify everything as night.
    for (const bad of ['', undefined, 'noon', '25:00', '12:60', '1200', '12:0']) {
      expect(parseHhMm(bad as string | undefined)).toBeNull();
    }
  });
});

describe('isWithinDayWindow', () => {
  test('normal window (05:30-19:00)', () => {
    const s = HHMM(5, 30);
    const e = HHMM(19);
    expect(isWithinDayWindow(HHMM(5, 29), s, e)).toBe(false);
    expect(isWithinDayWindow(HHMM(5, 30), s, e)).toBe(true); // start inclusive
    expect(isWithinDayWindow(HHMM(12), s, e)).toBe(true);
    expect(isWithinDayWindow(HHMM(18, 59), s, e)).toBe(true);
    expect(isWithinDayWindow(HHMM(19), s, e)).toBe(false); // end exclusive
  });

  test('★ wrapping window (08:00-00:00) — the shipped DEFAULT', () => {
    // end <= start means "until end of day". The old hardcoded 8-22 never had to
    // handle this, which is why code and declared default disagreed.
    const s = HHMM(8);
    const e = HHMM(0);
    expect(isWithinDayWindow(HHMM(7, 59), s, e)).toBe(false);
    expect(isWithinDayWindow(HHMM(8), s, e)).toBe(true);
    expect(isWithinDayWindow(HHMM(23, 59), s, e)).toBe(true);
    expect(isWithinDayWindow(HHMM(0), s, e)).toBe(false);
    expect(isWithinDayWindow(HHMM(3), s, e)).toBe(false);
  });

  test('wrapping window crossing midnight (22:00-06:00)', () => {
    const s = HHMM(22);
    const e = HHMM(6);
    expect(isWithinDayWindow(HHMM(23), s, e)).toBe(true);
    expect(isWithinDayWindow(HHMM(2), s, e)).toBe(true);
    expect(isWithinDayWindow(HHMM(6), s, e)).toBe(false);
    expect(isWithinDayWindow(HHMM(12), s, e)).toBe(false);
  });

  test('start === end is always day, never permanent night', () => {
    // Night carries the more aggressive standing orders, so a config typo must
    // not silently pin an agent there.
    expect(isWithinDayWindow(HHMM(3), HHMM(9), HHMM(9))).toBe(true);
    expect(isWithinDayWindow(HHMM(21), HHMM(9), HHMM(9))).toBe(true);
  });
});

describe('resolveAgentSchedule', () => {
  test('agent config overrides org context', () => {
    const root = fixtureRoot(
      'acme',
      'dev',
      { timezone: 'America/Los_Angeles', day_mode_start: '05:30', day_mode_end: '19:00' },
      { timezone: 'Europe/Berlin', day_mode_end: '21:00' },
    );
    const s = resolveAgentSchedule('acme', 'dev', root);
    expect(s).toEqual({ timezone: 'Europe/Berlin', dayStart: '05:30', dayEnd: '21:00' });
    rmSync(root, { recursive: true, force: true });
  });

  test('org context used when the agent overrides nothing', () => {
    const root = fixtureRoot('acme', 'dev', {
      timezone: 'America/Los_Angeles',
      day_mode_start: '05:30',
      day_mode_end: '19:00',
    });
    expect(resolveAgentSchedule('acme', 'dev', root)).toEqual({
      timezone: 'America/Los_Angeles',
      dayStart: '05:30',
      dayEnd: '19:00',
    });
    rmSync(root, { recursive: true, force: true });
  });

  test('missing config falls back to framework defaults, not a throw', () => {
    // A fresh install has neither file; that is not an error condition.
    const root = mkdtempSync(join(tmpdir(), 'ctx-sched-empty-'));
    expect(resolveAgentSchedule('nope', 'nobody', root)).toEqual({
      timezone: 'UTC',
      dayStart: DEFAULT_DAY_START,
      dayEnd: DEFAULT_DAY_END,
    });
    rmSync(root, { recursive: true, force: true });
  });

  test('malformed JSON warns and falls back instead of crashing the heartbeat', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-sched-bad-'));
    mkdirSync(join(root, 'orgs', 'acme'), { recursive: true });
    writeFileSync(join(root, 'orgs', 'acme', 'context.json'), '{ not json');
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveAgentSchedule('acme', 'dev', root).timezone).toBe('UTC');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  test('blank string values do not shadow the next level of the chain', () => {
    const root = fixtureRoot(
      'acme',
      'dev',
      { timezone: 'America/Los_Angeles', day_mode_start: '05:30', day_mode_end: '19:00' },
      { timezone: '   ' },
    );
    expect(resolveAgentSchedule('acme', 'dev', root).timezone).toBe('America/Los_Angeles');
    rmSync(root, { recursive: true, force: true });
  });
});

// ★ THE REGRESSION GUARD. These are the hours the fleet had wrong.
describe('★ the 11 hours/day the fleet was misclassifying', () => {
  const TZ = 'America/Los_Angeles';
  const START = '05:30';
  const END = '19:00';

  /** Freeze the clock at a UTC instant and report the mode under leadio config. */
  const modeAtUtc = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    return detectDayNightMode(TZ, START, END);
  };

  // PDT = UTC-7. Band 1: 01:00-05:00 PT was called DAY, should be NIGHT.
  test.each([
    ['2026-07-22T08:00:00Z', '01:00 PT'],
    ['2026-07-22T10:00:00Z', '03:00 PT'],
    ['2026-07-22T12:00:00Z', '05:00 PT'],
  ])('%s (%s) is NIGHT — old code said day', (iso) => {
    expect(modeAtUtc(iso)).toBe('night');
  });

  // Band 2: 15:00-20:00 PT was called NIGHT, should be DAY. This is the band
  // the original ticket's 18:50 PT symptom sits in, and it is John's whole
  // afternoon and evening — the window he is most reachable.
  test.each([
    ['2026-07-22T22:00:00Z', '15:00 PT'],
    ['2026-07-23T00:00:00Z', '17:00 PT'],
    ['2026-07-23T01:50:00Z', '18:50 PT — the reported symptom'],
    ['2026-07-23T02:00:00Z', '19:00 PT is night (end exclusive)'],
  ])('%s (%s)', (iso, label) => {
    expect(modeAtUtc(iso)).toBe(label.startsWith('19:00') ? 'night' : 'day');
  });

  test('a timezone-only fix is NOT sufficient — the window must come from config too', () => {
    vi.useFakeTimers();
    // 06:00 PT: inside the configured 05:30 day start, but outside a hardcoded
    // 08:00 start. Correct zone alone still gets this wrong.
    vi.setSystemTime(new Date('2026-07-22T13:00:00Z'));
    expect(detectDayNightMode(TZ, START, END)).toBe('day');
    expect(detectDayNightMode(TZ, '08:00', '22:00')).toBe('night'); // the old hardcoded window
  });

  test('a window-only fix is NOT sufficient — the zone must come from config too', () => {
    vi.useFakeTimers();
    // 22:00 UTC = 15:00 PT. Same window applied in each zone gives opposite
    // answers: 15:00 is inside 05:30-19:00, 22:00 is outside it.
    vi.setSystemTime(new Date('2026-07-22T22:00:00Z'));
    expect(detectDayNightMode(TZ, START, END)).toBe('day'); // 15:00 PT
    expect(detectDayNightMode('UTC', START, END)).toBe('night'); // 22:00 UTC
  });
});

describe('detectDayNightMode fallbacks', () => {
  test('unknown timezone warns and falls back to UTC rather than throwing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T12:00:00Z'));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(detectDayNightMode('Not/AZone', '08:00', '22:00')).toBe('day');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('unparseable window warns and falls back to the framework default window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T12:00:00Z')); // 12:00 UTC
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(detectDayNightMode('UTC', 'garbage', 'also-garbage')).toBe('day');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('defaults are used when the window args are omitted entirely', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T23:00:00Z')); // 23:00 UTC — day under 08:00-00:00
    expect(detectDayNightMode('UTC')).toBe('day');
    vi.setSystemTime(new Date('2026-07-22T03:00:00Z')); // 03:00 UTC — night
    expect(detectDayNightMode('UTC')).toBe('night');
  });
});
