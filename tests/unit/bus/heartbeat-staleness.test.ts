import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveStalenessThreshold,
  isHeartbeatStale,
  STALE_INTERVAL_MULTIPLIER,
  ASSUMED_HEARTBEAT_INTERVAL_MS,
} from '../../../src/bus/heartbeat';

const HOUR = 60 * 60 * 1000;

/** Stand-in for the real cron reader; the join is what's under test, not IO. */
function cronsReturning(crons: Array<{ name: string; schedule?: string; enabled?: boolean }>) {
  return {
    readCrons: () => crons,
    parseDurationMs: (interval: string) => {
      const m = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
      if (!m) return NaN;
      const mult: Record<string, number> = { m: 60_000, h: HOUR, d: 24 * HOUR, w: 7 * 24 * HOUR };
      return parseInt(m[1], 10) * mult[m[2]];
    },
  };
}

describe('resolveStalenessThreshold', () => {
  it('scales to the agent\'s own heartbeat interval', () => {
    const t = resolveStalenessThreshold('developer', cronsReturning([{ name: 'heartbeat', schedule: '4h' }]));

    expect(t.staleAfterMs).toBe(4 * HOUR * STALE_INTERVAL_MULTIPLIER);
    expect(t.basis).toBe('agent-interval');
  });

  it('gives a shorter-looping agent a proportionally shorter threshold', () => {
    const fast = resolveStalenessThreshold('a', cronsReturning([{ name: 'heartbeat', schedule: '2h' }]));
    const slow = resolveStalenessThreshold('b', cronsReturning([{ name: 'heartbeat', schedule: '6h' }]));

    expect(fast.staleAfterMs).toBe(4 * HOUR);
    expect(slow.staleAfterMs).toBe(12 * HOUR);
  });

  it('declares an assumed basis for a cron-expression schedule rather than guessing', () => {
    const t = resolveStalenessThreshold('x', cronsReturning([{ name: 'heartbeat', schedule: '0 */4 * * *' }]));

    expect(t.basis).toBe('assumed');
  });

  // The 2x tolerates one missed cycle of a schedule we can SEE. With no
  // resolvable schedule there is no cycle to tolerate, so grace is not
  // extended — an unknown interval must not read as healthier than a known
  // one. Uncertainty alarms earlier, not later.
  it('does not extend grace when the interval is unknown', () => {
    const unknown = resolveStalenessThreshold('x', cronsReturning([]));
    const known = resolveStalenessThreshold('y', cronsReturning([{ name: 'heartbeat', schedule: '4h' }]));

    expect(unknown.staleAfterMs).toBe(ASSUMED_HEARTBEAT_INTERVAL_MS);
    expect(unknown.staleAfterMs).toBeLessThan(known.staleAfterMs);
  });

  it('declares an assumed basis when the agent has no heartbeat cron', () => {
    expect(resolveStalenessThreshold('x', cronsReturning([])).basis).toBe('assumed');
    expect(
      resolveStalenessThreshold('x', cronsReturning([{ name: 'daily-report', schedule: '1d' }])).basis,
    ).toBe('assumed');
  });

  it('ignores a disabled heartbeat cron', () => {
    const t = resolveStalenessThreshold('x', cronsReturning([{ name: 'heartbeat', schedule: '1h', enabled: false }]));

    expect(t.basis).toBe('assumed');
  });

  it('declares an assumed basis when crons cannot be read', () => {
    const t = resolveStalenessThreshold('x', {
      readCrons: () => { throw new Error('unreadable'); },
      parseDurationMs: () => NaN,
    });

    expect(t.basis).toBe('assumed');
  });
});

describe('isHeartbeatStale', () => {
  const now = Date.parse('2026-07-17T12:00:00Z');
  const fourHourAgent = resolveStalenessThreshold('developer', cronsReturning([{ name: 'heartbeat', schedule: '4h' }]));

  // The bug this replaces: a fixed 2h threshold flagged a healthy 4h-loop
  // agent as [STALE] for half of every cycle.
  it('does not flag a 4h-loop agent two hours after its heartbeat', () => {
    expect(isHeartbeatStale('2026-07-17T10:00:00Z', fourHourAgent, now)).toBe(false);
  });

  it('does not flag it at one missed cycle — that is jitter, not a signal', () => {
    expect(isHeartbeatStale('2026-07-17T07:30:00Z', fourHourAgent, now)).toBe(false);
  });

  it('flags it past two of its own intervals', () => {
    expect(isHeartbeatStale('2026-07-17T03:00:00Z', fourHourAgent, now)).toBe(true);
  });

  it('flags a 1h-loop agent at the same age that is healthy for a 4h agent', () => {
    const hourly = resolveStalenessThreshold('fast', cronsReturning([{ name: 'heartbeat', schedule: '1h' }]));
    const threeHoursAgo = '2026-07-17T09:00:00Z';

    expect(isHeartbeatStale(threeHoursAgo, hourly, now)).toBe(true);
    expect(isHeartbeatStale(threeHoursAgo, fourHourAgent, now)).toBe(false);
  });

  it('treats a missing or unparseable heartbeat as stale', () => {
    expect(isHeartbeatStale(undefined, fourHourAgent, now)).toBe(true);
    expect(isHeartbeatStale('not-a-date', fourHourAgent, now)).toBe(true);
  });
});

/**
 * This suite replaces a detector that consolidating the rule destroyed.
 *
 * The 2h/5h disagreement between the CLI and metrics is what exposed the bug —
 * but only because someone happened to run both and happened to notice they
 * contradicted. That detector needed a reader. Unifying the rule removes it, so
 * the invariant it accidentally protected is asserted here instead, where it
 * fires without anyone watching.
 */
describe('invariant: one staleness rule, scaled to the subject', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../../../src', p), 'utf-8');

  it('no consumer hard-codes its own staleness threshold', () => {
    for (const file of ['cli/bus.ts', 'bus/metrics.ts']) {
      const text = src(file);
      // The literal shapes the two old thresholds were written in.
      expect(text).not.toMatch(/2 \* 60 \* 60 \* 1000/);
      expect(text).not.toMatch(/5 \* 60 \* 60 \* 1000/);
    }
  });

  it('every staleness consumer goes through the shared helper', () => {
    for (const file of ['cli/bus.ts', 'bus/metrics.ts']) {
      expect(src(file)).toContain('resolveStalenessThreshold');
    }
  });

  it('the threshold is a multiple of the interval, not a constant', () => {
    const doubled = resolveStalenessThreshold('x', cronsReturning([{ name: 'heartbeat', schedule: '3h' }]));

    expect(doubled.staleAfterMs).toBe(3 * HOUR * STALE_INTERVAL_MULTIPLIER);
  });
});
