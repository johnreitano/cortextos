import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Path-aware fs mocks. existsSync is the one we actually drive per-test:
// it returns true for any path EXCEPT the MMRAG_CONFIG one (when the test
// wants to simulate a missing config) so loadSecretsEnv and other path
// lookups still work normally inside the module under test.
const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fsMocks.readFileSync>) => fsMocks.readFileSync(...args),
    mkdirSync: (...args: Parameters<typeof fsMocks.mkdirSync>) => fsMocks.mkdirSync(...args),
  };
});

// Mock execFileSync so we can assert whether it was called (and optionally
// simulate a successful python response).
const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

// Mock normalizeOrgName to a passthrough identity — we are not testing org
// normalization here, that has its own dedicated test file.
vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

const { queryKnowledgeBase, ingestKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

// Minimal BusPaths stub — knowledge-base.ts doesn't actually USE the paths
// object at call time, just the options/env it constructs.
const dummyPaths = {
  stateDir: '/tmp/agent/state',
  logDir: '/tmp/agent/logs',
  ctxRoot: '/tmp/agent',
  instanceId: 'test',
  agentName: 'tester',
  org: 'TestOrg',
  inboxDir: '/tmp/agent/inbox',
  inflightDir: '/tmp/agent/inflight',
  processedDir: '/tmp/agent/processed',
  outboxDir: '/tmp/agent/outbox',
} as any;

const baseOptions = {
  org: 'TestOrg',
  agent: 'tester',
  frameworkRoot: '/home/test/cortextOS',
  instanceId: 'test',
};

let warnLog: string[] = [];
let originalWarn: typeof console.warn;
let logLog: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.mkdirSync.mockReset();
  execFileSyncMock.mockReset();

  warnLog = [];
  logLog = [];
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLog.push(args.map((a) => String(a)).join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

/**
 * Helper: make existsSync return false ONLY for paths that end with
 * knowledge-base/config.json (i.e. the MMRAG_CONFIG file), true for everything
 * else. Simulates a freshly-created agent with no KB configured yet.
 */
function mockMissingKbConfig(): void {
  fsMocks.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return false;
    return true;
  });
}

/**
 * Helper: make existsSync return true for everything, simulating a fully
 * configured KB with config.json present on disk.
 */
function mockConfiguredKb(): void {
  fsMocks.existsSync.mockImplementation(() => true);
}

describe('ingestKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    // Must NOT throw. Previously this path threw an unhandled execFileSync
    // error that dumped a Node stack trace on top of the python stderr.
    expect(() =>
      ingestKnowledgeBase(['/some/file.md'], baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    // Warn must include the org name AND an actionable hint ("run setup").
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    // Warn must carry the [kb] prefix so operators can filter log lines.
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called with the mmrag ingest args', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // First positional arg is the python path, second is the argv array.
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['ingest', '/some/file.md']));
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('queryKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + report every target collection as FAILED, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    const result = queryKnowledgeBase(dummyPaths, 'what is cortextos?', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'what is cortextos?',
      collection: 'shared-TestOrg',
      attempted: ['shared-TestOrg', 'agent-tester'],
      failures: [
        {
          collection: 'shared-TestOrg',
          message: 'knowledge base not configured for org TestOrg — run setup to enable',
        },
        {
          collection: 'agent-tester',
          message: 'knowledge base not configured for org TestOrg — run setup to enable',
        },
      ],
    });
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called, happy-path query returns results', () => {
    mockConfiguredKb();
    // Mock mmrag.py --json output: a JSON blob with one result.
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        results: [
          { content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).toHaveBeenCalled();
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].content).toBe('hit');
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

/**
 * The defect these cover: a hard probe failure (a 429 from the embedding API,
 * a timeout, a malformed payload) used to be flattened into `results: []` —
 * byte-identical to a collection that genuinely holds nothing. Callers then
 * reported "no prior work exists" off a query that was never answered.
 *
 * The load-bearing assertion in this block is the PAIR: `failed` and `empty`
 * must not produce the same value. Either test alone can pass while the bug is
 * fully present, so they are written adjacently and neither should be deleted
 * without the other.
 */
describe('queryKnowledgeBase — failed must never look like empty', () => {
  /** Simulate execFileSync throwing the way a nonzero-exit python probe does. */
  function throwWithStderr(stderr: string, extra: Record<string, unknown> = {}): void {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error('Command failed') as Error & Record<string, unknown>;
      err.stderr = stderr;
      Object.assign(err, extra);
      throw err;
    });
  }

  const GEMINI_429 = [
    'Traceback (most recent call last):',
    '  File "/x/mmrag.py", line 1, in <module>',
    "google.genai.errors.ClientError: 429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'Your prepayment credits are depleted.', 'status': 'RESOURCE_EXHAUSTED'}}",
  ].join('\n');

  it('probe fails (429): results empty BUT failures populated — not a clean empty', () => {
    mockConfiguredKb();
    throwWithStderr(GEMINI_429);

    const result = queryKnowledgeBase(dummyPaths, 'stripe billing', baseOptions);

    expect(result.results).toEqual([]);
    // The whole point: emptiness is now qualified.
    expect(result.failures.length).toBe(result.attempted.length);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].message).toMatch(/RESOURCE_EXHAUSTED/);
    // Full traceback preserved for the operator, not just the one-line summary.
    expect(result.failures[0].detail).toContain('Traceback');
  });

  it('genuine empty: results empty AND failures empty — the only verified "none"', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue(JSON.stringify({ results: [], result_count: 0 }));

    const result = queryKnowledgeBase(dummyPaths, 'stripe billing', baseOptions);

    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('the two states are distinguishable (regression guard for the flattening bug)', () => {
    mockConfiguredKb();

    execFileSyncMock.mockReturnValue(JSON.stringify({ results: [], result_count: 0 }));
    const genuinelyEmpty = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    throwWithStderr(GEMINI_429);
    const failed = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    // Both have zero results. That is exactly why `results` alone can never be
    // the signal, and why the old code was wrong to treat it as one.
    expect(genuinelyEmpty.results).toEqual(failed.results);
    expect(genuinelyEmpty).not.toEqual(failed);
    expect(genuinelyEmpty.failures.length).toBe(0);
    expect(failed.failures.length).toBeGreaterThan(0);
  });

  it('partial failure: one collection answers, one errors — results kept, failure recorded', () => {
    mockConfiguredKb();
    let call = 0;
    execFileSyncMock.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return JSON.stringify({
          results: [{ content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' }],
        });
      }
      const err = new Error('Command failed') as Error & Record<string, unknown>;
      err.stderr = GEMINI_429;
      throw err;
    });

    // scope 'all' with an agent queries shared-* then agent-*.
    const result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    expect(result.results).toHaveLength(1);
    expect(result.attempted).toHaveLength(2);
    // Results exist, but the set is incomplete — absence from it proves nothing.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].collection).toBe('agent-tester');
  });

  it('timeout is named explicitly, not folded into a generic error', () => {
    mockConfiguredKb();
    throwWithStderr('', { code: 'ETIMEDOUT', signal: 'SIGTERM' });

    const result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    expect(result.failures[0].message).toMatch(/timed out after 30000ms/);
  });

  it('exit 0 with unparseable output is a FAILURE, not an empty collection', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('mmrag: loading model...\n');

    const result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    expect(result.results).toEqual([]);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].message).toMatch(/no JSON payload/);
  });

  it('exit 0 with truncated JSON is a FAILURE, not an empty collection', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": [{"content": "half');

    const result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    expect(result.results).toEqual([]);
    expect(result.failures[0].message).toMatch(/malformed JSON/);
  });

  it('captured stderr is re-emitted, not swallowed by the capture', () => {
    mockConfiguredKb();
    throwWithStderr(GEMINI_429);

    const written: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      queryKnowledgeBase(dummyPaths, 'q', baseOptions);
    } finally {
      process.stderr.write = originalWrite;
    }

    // Switching to stdio:'pipe' must not become a way to LOSE the traceback
    // the operator used to see.
    expect(written.join('')).toContain('RESOURCE_EXHAUSTED');
  });
});

describe('kb warn messages — UX invariants', () => {
  it('both warn messages name the org and suggest "run setup"', () => {
    // Drive ingest path
    mockMissingKbConfig();
    ingestKnowledgeBase(['/f.md'], { ...baseOptions, org: 'SpecificOrg' });
    // Drive query path
    mockMissingKbConfig();
    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, org: 'SpecificOrg' });

    // At least one warn per call site, each containing the org name + hint
    const specificOrgWarns = warnLog.filter((m) => m.includes('SpecificOrg'));
    expect(specificOrgWarns.length).toBeGreaterThanOrEqual(2);
    expect(specificOrgWarns.every((m) => /run setup/i.test(m))).toBe(true);
  });
});
