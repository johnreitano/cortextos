import { execFileSync } from 'child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import { buildKBEnv, getVenvPython } from './knowledge-base.js';
import { normalizeOrgName } from '../utils/org.js';

/**
 * Stale/empty-collection alarm.
 *
 * Every other KB safeguard we own is a guard: it sits in the path of a call and
 * refuses a bad one. A guard cannot catch a step that never runs — an ingest
 * that was never invoked, or a file that was never named in its argument list,
 * raises nothing and reports nothing. That failure mode is only visible from
 * outside the call path, by comparing what is ON DISK against what actually
 * reached the collection. This module is that comparison.
 *
 * Both real incidents behind it (2026-07-16):
 *  - agent-analyst held 61 documents while ~260 chunks were missing; its
 *    HEARTBEAT.md had no kb-ingest step at all, so nothing ever refused.
 *  - experiments/learnings.md (374 lines, 46 lessons) was absent from every
 *    heartbeat's argument list fleet-wide; the step exited 0 every cycle.
 *
 * The unit of truth here is the file on disk, NOT the heartbeat's argument
 * list. Checking the documented arguments would only re-assert the belief that
 * was already wrong; a file that exists and never reached the collection is an
 * alarm regardless of what any instruction block claims to ingest.
 */

export type KBFreshnessSeverity = 'critical' | 'warning';

export type KBFreshnessKind =
  | 'collection_absent'
  | 'collection_empty'
  | 'file_never_ingested'
  | 'file_stale';

export interface KBFreshnessFinding {
  severity: KBFreshnessSeverity;
  kind: KBFreshnessKind;
  agent: string;
  collection: string;
  /** Absolute path of the offending file, when the finding is about one file. */
  file?: string;
  detail: string;
}

export interface KBFreshnessReport {
  agent: string;
  collection: string;
  /** False when the org has no KB config yet — nothing can be concluded. */
  configured: boolean;
  /** Knowledge files present on disk — the set that ought to be indexed. */
  onDiskFiles: number;
  /**
   * How many of those on-disk files are actually indexed. Deliberately NOT the
   * collection's total source count: a collection also holds sources outside
   * this set (ingested drafts, files since deleted), and counting those made
   * the coverage ratio read as complete — "34/17" — while real files were
   * missing. Coverage must only count what it claims to cover.
   */
  indexedFiles: number;
  /** Total distinct sources in the collection, from any path. */
  collectionFiles: number;
  chunkCount: number;
  findings: KBFreshnessFinding[];
}

interface CollectionListing {
  exists: boolean;
  chunkCount: number;
  /** Resolved source path → last ingest time (naive local ISO from mmrag). */
  sources: Map<string, string>;
}

/** One heartbeat cycle is 4h; a full day of missed ingests is unambiguous. */
export const DEFAULT_STALE_HOURS = 24;

/**
 * Knowledge files an agent is expected to have indexed: its long-term memory,
 * every daily memory file, and its experiment learnings.
 *
 * Empty files are excluded deliberately. mmrag skips a zero-byte source without
 * indexing it, so including them would raise a `file_never_ingested` alarm that
 * no ingest could ever clear — an alarm that cannot be silenced by fixing the
 * thing it names trains its operator to ignore it, which costs more than the
 * empty file is worth.
 */
export function listAgentKnowledgeFiles(agentDir: string): string[] {
  const candidates: string[] = [join(agentDir, 'MEMORY.md')];

  for (const sub of ['memory', 'experiments']) {
    const dir = join(agentDir, sub);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.md')) candidates.push(join(dir, name));
    }
  }

  const files: string[] = [];
  for (const p of candidates) {
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size === 0) continue;
      // mmrag records `Path.resolve()` — symlinks resolved — as the source, so
      // resolve here too or the join misses on any symlinked path.
      files.push(realpathSync(p));
    } catch {
      // Missing or unreadable — not a knowledge file we can assert anything about.
    }
  }
  return files.sort();
}

/**
 * Read a collection's per-source inventory via `mmrag list --json`.
 */
function listCollection(
  collection: string,
  env: Record<string, string>,
  frameworkRoot: string,
): CollectionListing {
  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  let output: string;
  try {
    output = execFileSync(
      pythonPath,
      [mmragPath, 'list', '--collection', collection, '--json'],
      { encoding: 'utf-8', timeout: 60_000, env },
    );
  } catch {
    // Treat an unreadable collection as absent rather than as healthy: this
    // check exists to fail loudly, so the uncertain case must alarm.
    return { exists: false, chunkCount: 0, sources: new Map() };
  }

  const start = output.indexOf('{');
  if (start === -1) return { exists: false, chunkCount: 0, sources: new Map() };

  try {
    const raw = JSON.parse(output.slice(start)) as {
      exists?: boolean;
      chunk_count?: number;
      files?: Array<{ source?: string; last_ingested_at?: string }>;
    };
    const sources = new Map<string, string>();
    for (const f of raw.files || []) {
      if (f.source) sources.set(f.source, f.last_ingested_at || '');
    }
    return {
      exists: raw.exists !== false,
      chunkCount: raw.chunk_count || 0,
      sources,
    };
  } catch {
    return { exists: false, chunkCount: 0, sources: new Map() };
  }
}

/**
 * mmrag stamps `ingested_at` with a naive local-time ISO string
 * (`time.strftime('%Y-%m-%dT%H:%M:%S')`), and file mtimes are absolute
 * instants. JS parses a naive date-time as local time, which is the same clock
 * mmrag wrote it on, so the two are comparable — but only because both sides
 * are evaluated on the machine that ran the ingest.
 */
function parseIngestedAt(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compare one agent's on-disk knowledge files against its KB collection.
 */
export function checkAgentKBFreshness(options: {
  agent: string;
  agentDir: string;
  org: string;
  frameworkRoot: string;
  instanceId: string;
  staleHours?: number;
  now?: Date;
}): KBFreshnessReport {
  const { agent, agentDir, frameworkRoot, instanceId } = options;
  const staleHours = options.staleHours ?? DEFAULT_STALE_HOURS;
  const org = normalizeOrgName(frameworkRoot, options.org);
  const collection = `agent-${agent}`;
  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  const onDisk = listAgentKnowledgeFiles(agentDir);

  if (!existsSync(env.MMRAG_CONFIG)) {
    return {
      agent,
      collection,
      configured: false,
      onDiskFiles: onDisk.length,
      indexedFiles: 0,
      collectionFiles: 0,
      chunkCount: 0,
      findings: [],
    };
  }

  const listing = listCollection(collection, env, frameworkRoot);
  const findings: KBFreshnessFinding[] = [];

  // With nothing on disk there is no claim to check: an empty collection is the
  // correct state for an agent that has written no memory yet, so reporting it
  // would be noise rather than a finding.
  if (onDisk.length > 0) {
    if (!listing.exists) {
      findings.push({
        severity: 'critical',
        kind: 'collection_absent',
        agent,
        collection,
        detail:
          `Collection ${collection} does not exist, but ${onDisk.length} knowledge ` +
          `file(s) are on disk. The ingest step has never run for this agent.`,
      });
    } else if (listing.sources.size === 0) {
      findings.push({
        severity: 'critical',
        kind: 'collection_empty',
        agent,
        collection,
        detail:
          `Collection ${collection} is empty, but ${onDisk.length} knowledge ` +
          `file(s) are on disk. No ingest has ever landed.`,
      });
    }
  }

  const staleMs = staleHours * 3600_000;
  const now = options.now ?? new Date();

  for (const file of onDisk) {
    const ingestedAt = listing.sources.get(file);

    if (ingestedAt === undefined) {
      // Only worth reporting per-file when the collection itself is alive;
      // otherwise the collection-level finding already says it, once.
      if (listing.exists && listing.sources.size > 0) {
        // A file written since the last heartbeat has not yet had a cycle in
        // which it COULD be ingested, so its absence is not evidence of an
        // absent step. Without this window every agent's new daily memory file
        // raises a critical for the first hours of every day — and an alarm
        // that cries wolf daily is one nobody reads on the day it is right.
        let mtimeMs: number;
        try {
          mtimeMs = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (now.getTime() - mtimeMs > staleMs) {
          findings.push({
            severity: 'critical',
            kind: 'file_never_ingested',
            agent,
            collection,
            file,
            detail:
              `${file} exists on disk but has no chunks in ${collection}. It was ` +
              `never named in an ingest — the step cannot refuse an argument it ` +
              `was never given.`,
          });
        }
      }
      continue;
    }

    const ingestedDate = parseIngestedAt(ingestedAt);
    if (!ingestedDate) continue;

    let mtime: Date;
    try {
      mtime = statSync(file).mtime;
    } catch {
      continue;
    }

    if (mtime.getTime() - ingestedDate.getTime() > staleMs) {
      const hours = Math.floor((now.getTime() - ingestedDate.getTime()) / 3600_000);
      findings.push({
        severity: 'warning',
        kind: 'file_stale',
        agent,
        collection,
        file,
        detail:
          `${file} changed more than ${staleHours}h after its last ingest ` +
          `(${ingestedAt}, ~${hours}h ago). The indexed copy is behind the file.`,
      });
    }
  }

  return {
    agent,
    collection,
    configured: true,
    onDiskFiles: onDisk.length,
    indexedFiles: onDisk.filter((f) => listing.sources.has(f)).length,
    collectionFiles: listing.sources.size,
    chunkCount: listing.chunkCount,
    findings,
  };
}
