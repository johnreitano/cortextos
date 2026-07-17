import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// A temp HOME so buildKBEnv's ~/.cortextos/... paths land somewhere disposable.
let fakeHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => fakeHome };
});

// Stub the python call — these tests are about the join between disk and
// collection, not about mmrag itself.
const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

const { checkAgentKBFreshness, listAgentKnowledgeFiles } = await import(
  '../../../src/bus/kb-freshness.js'
);

const ORG = 'TestOrg';
const AGENT = 'analyst';
const INSTANCE = 'test-instance';

let root: string;
let agentDir: string;
let frameworkRoot: string;

/** Canned `mmrag list --json` payload. */
function listing(files: Array<{ source: string; last_ingested_at?: string }>, exists = true) {
  return JSON.stringify({
    collection: `agent-${AGENT}`,
    exists,
    file_count: files.length,
    chunk_count: files.length * 5,
    files: files.map((f) => ({
      source: f.source,
      type: 'markdown',
      filename: 'x.md',
      chunks: 5,
      last_ingested_at: f.last_ingested_at ?? '2026-07-16T12:00:00',
    })),
  });
}

/** Write a file and pin its mtime so staleness is deterministic. */
function writeAt(path: string, content: string, mtime: Date) {
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
  return realpathSync(path);
}

function run(opts: { staleHours?: number } = {}) {
  return checkAgentKBFreshness({
    agent: AGENT,
    agentDir,
    org: ORG,
    frameworkRoot,
    instanceId: INSTANCE,
    now: new Date('2026-07-17T00:00:00'),
    ...opts,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kbfresh-'));
  fakeHome = join(root, 'home');
  frameworkRoot = join(root, 'framework');
  agentDir = join(frameworkRoot, 'orgs', ORG, 'agents', AGENT);
  mkdirSync(join(agentDir, 'memory'), { recursive: true });
  mkdirSync(join(agentDir, 'experiments'), { recursive: true });

  // A KB config on disk marks the org as configured.
  const kbRoot = join(fakeHome, '.cortextos', INSTANCE, 'orgs', ORG, 'knowledge-base');
  mkdirSync(kbRoot, { recursive: true });
  writeFileSync(join(kbRoot, 'config.json'), '{}');

  execFileSyncMock.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listAgentKnowledgeFiles', () => {
  it('collects MEMORY.md, daily memory, and experiment learnings', () => {
    writeFileSync(join(agentDir, 'MEMORY.md'), 'long term');
    writeFileSync(join(agentDir, 'memory', '2026-07-16.md'), 'daily');
    writeFileSync(join(agentDir, 'experiments', 'learnings.md'), 'lessons');

    const files = listAgentKnowledgeFiles(agentDir);

    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith('MEMORY.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('2026-07-16.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('learnings.md'))).toBe(true);
  });

  it('excludes empty files, which no ingest would ever index', () => {
    writeFileSync(join(agentDir, 'MEMORY.md'), 'content');
    writeFileSync(join(agentDir, 'memory', '2026-07-17.md'), '');

    const files = listAgentKnowledgeFiles(agentDir);

    expect(files).toHaveLength(1);
    expect(files[0].endsWith('MEMORY.md')).toBe(true);
  });

  it('ignores non-markdown files', () => {
    writeFileSync(join(agentDir, 'MEMORY.md'), 'content');
    writeFileSync(join(agentDir, 'memory', 'notes.txt'), 'not markdown');

    expect(listAgentKnowledgeFiles(agentDir)).toHaveLength(1);
  });

  it('returns nothing for an agent with no knowledge files', () => {
    expect(listAgentKnowledgeFiles(agentDir)).toEqual([]);
  });
});

describe('checkAgentKBFreshness', () => {
  it('flags an absent collection as critical when memory exists on disk', () => {
    writeFileSync(join(agentDir, 'MEMORY.md'), 'long term');
    execFileSyncMock.mockReturnValue(listing([], false));

    const report = run();

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('collection_absent');
    expect(report.findings[0].severity).toBe('critical');
  });

  it('flags an empty collection as critical when memory exists on disk', () => {
    writeFileSync(join(agentDir, 'MEMORY.md'), 'long term');
    execFileSyncMock.mockReturnValue(listing([], true));

    const report = run();

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('collection_empty');
    expect(report.findings[0].severity).toBe('critical');
  });

  // The analyst's learnings.md: present on disk, never in the argument list,
  // while the collection looked healthy and the step exited 0 every cycle.
  it('flags a file that exists on disk but was never ingested', () => {
    const memory = writeAt(join(agentDir, 'MEMORY.md'), 'long term', new Date('2026-07-16T10:00:00'));
    writeAt(join(agentDir, 'experiments', 'learnings.md'), '46 lessons', new Date('2026-07-01T09:00:00'));
    execFileSyncMock.mockReturnValue(listing([{ source: memory }]));

    const report = run();

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('file_never_ingested');
    expect(report.findings[0].severity).toBe('critical');
    expect(report.findings[0].file).toContain('learnings.md');
  });

  // Found by running the check against the live fleet: without a grace window
  // every agent's freshly-written daily memory file raised a critical for the
  // hours between its creation and the next heartbeat's ingest.
  it('does not flag a file written since the last heartbeat', () => {
    const memory = writeAt(join(agentDir, 'MEMORY.md'), 'long term', new Date('2026-07-16T10:00:00'));
    writeAt(join(agentDir, 'memory', '2026-07-17.md'), 'todays notes', new Date('2026-07-16T23:30:00'));
    execFileSyncMock.mockReturnValue(listing([{ source: memory }]));

    // now = 2026-07-17T00:00, so the new file is 30 minutes old against a 24h window.
    expect(run().findings).toEqual([]);
  });

  it('still flags an un-ingested file once it has outlived the window', () => {
    const memory = writeAt(join(agentDir, 'MEMORY.md'), 'long term', new Date('2026-07-16T10:00:00'));
    writeAt(join(agentDir, 'memory', '2026-07-17.md'), 'notes', new Date('2026-07-16T23:30:00'));
    execFileSyncMock.mockReturnValue(listing([{ source: memory }]));

    const report = run({ staleHours: 0.25 });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('file_never_ingested');
    expect(report.findings[0].file).toContain('2026-07-17.md');
  });

  // The live run reported "34/17 indexed" for an agent that was missing files:
  // coverage counted sources the expected set never claimed.
  it('counts coverage against the expected set, not the collection total', () => {
    const memory = writeAt(join(agentDir, 'MEMORY.md'), 'long term', new Date('2026-07-16T10:00:00'));
    execFileSyncMock.mockReturnValue(
      listing([
        { source: memory },
        { source: '/somewhere/else/drafts/a-draft.md' },
        { source: '/somewhere/else/drafts/deleted.md' },
      ]),
    );

    const report = run();

    expect(report.onDiskFiles).toBe(1);
    expect(report.indexedFiles).toBe(1);
    expect(report.collectionFiles).toBe(3);
  });

  it('does not double-report per-file when the whole collection is empty', () => {
    writeFileSync(join(agentDir, 'MEMORY.md'), 'a');
    writeFileSync(join(agentDir, 'memory', '2026-07-16.md'), 'b');
    execFileSyncMock.mockReturnValue(listing([], true));

    const report = run();

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('collection_empty');
  });

  it('warns when a file changed well after its last ingest', () => {
    const memory = writeAt(join(agentDir, 'MEMORY.md'), 'edited', new Date('2026-07-16T23:00:00'));
    execFileSyncMock.mockReturnValue(
      listing([{ source: memory, last_ingested_at: '2026-07-15T09:00:00' }]),
    );

    const report = run();

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('file_stale');
    expect(report.findings[0].severity).toBe('warning');
  });

  it('stays quiet when the indexed copy is current', () => {
    const memory = writeAt(join(agentDir, 'MEMORY.md'), 'x', new Date('2026-07-16T12:00:00'));
    execFileSyncMock.mockReturnValue(
      listing([{ source: memory, last_ingested_at: '2026-07-16T12:05:00' }]),
    );

    const report = run();

    expect(report.findings).toEqual([]);
    expect(report.indexedFiles).toBe(1);
    expect(report.onDiskFiles).toBe(1);
  });

  it('tolerates an edit inside the stale window', () => {
    const memory = writeAt(join(agentDir, 'MEMORY.md'), 'x', new Date('2026-07-16T14:00:00'));
    execFileSyncMock.mockReturnValue(
      listing([{ source: memory, last_ingested_at: '2026-07-16T12:00:00' }]),
    );

    // 2h of drift, 24h budget.
    expect(run().findings).toEqual([]);
    // Same drift against a 1h budget is a warning.
    expect(run({ staleHours: 1 }).findings[0].kind).toBe('file_stale');
  });

  it('reports nothing for an agent with no knowledge files yet', () => {
    execFileSyncMock.mockReturnValue(listing([], false));

    const report = run();

    expect(report.findings).toEqual([]);
    expect(report.onDiskFiles).toBe(0);
  });

  it('treats an unreadable collection as absent rather than healthy', () => {
    writeFileSync(join(agentDir, 'MEMORY.md'), 'long term');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('chromadb exploded');
    });

    const report = run();

    expect(report.findings[0].kind).toBe('collection_absent');
    expect(report.findings[0].severity).toBe('critical');
  });

  it('concludes nothing when the org has no KB config', () => {
    rmSync(join(fakeHome, '.cortextos', INSTANCE, 'orgs', ORG, 'knowledge-base', 'config.json'));
    writeFileSync(join(agentDir, 'MEMORY.md'), 'long term');

    const report = run();

    expect(report.configured).toBe(false);
    expect(report.findings).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
