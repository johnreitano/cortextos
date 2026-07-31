import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';

/**
 * Knowledge base integration — calls mmrag.py directly (cross-platform,
 * no bash dependency).  Previously wrapped kb-*.sh bash scripts.
 */

/**
 * Resolve the Python interpreter inside the knowledge-base venv,
 * accounting for Windows vs Unix layout.
 */
function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

/**
 * Load .env and secrets.env files the same way the bash scripts did
 * (`set -o allexport && source …`).  Returns a flat key→value map.
 */
function loadSecretsEnv(frameworkRoot: string, org: string): Record<string, string> {
  const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
  const dotenvPath = join(frameworkRoot, '.env');
  const vars: Record<string, string> = {};
  for (const p of [dotenvPath, secretsPath]) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          // Strip surrounding quotes (single or double) that some .env files use
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}

/**
 * Check whether the knowledge base config file exists for a given env.
 *
 * The Python MMRAG tool loads its config from env.MMRAG_CONFIG
 * (`knowledge-base/config.json` under the org's state dir) and exits with
 * "Config not found. Run setup first" if the file is absent. When that
 * happens, execFileSync throws a non-zero-exit error which — if not caught
 * — produces a user-facing unhandled-throw stack dump on top of the
 * already-printed Python error. This helper lets callers detect the
 * missing-config state UP FRONT and respond gracefully (warn + return)
 * instead of relying on brittle stderr string matching after the throw.
 */
function kbConfigured(env: Record<string, string>): boolean {
  return existsSync(env.MMRAG_CONFIG);
}

/**
 * Build the full env object needed by mmrag.py calls.
 */
function buildKBEnv(
  frameworkRoot: string,
  org: string,
  instanceId: string,
  agent?: string,
): Record<string, string> {
  // Normalize org to its canonical filesystem casing BEFORE touching any
  // paths. Without this, a lowercase --org arg produces a ghost state dir
  // (~/.cortextos/<instance>/orgs/<lowercase>/knowledge-base/) with its own
  // MMRAG config.json, splitting KB state across two directories and
  // polluting dashboard sync with hits against a non-existent org.
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const secrets = loadSecretsEnv(frameworkRoot, canonicalOrg);
  return {
    ...process.env as Record<string, string>,
    ...secrets,
    CTX_ORG: canonicalOrg,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };
}

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

/**
 * A collection that could not be queried at all.
 *
 * This type exists so that "the KB returned nothing" and "the KB could not be
 * asked" stop being the same value. They previously both arrived as
 * `results: []`, which is a meaningful, wrong answer rather than an error:
 * every caller downstream reads it as "no prior work exists on this topic".
 */
export interface KBQueryFailure {
  collection: string;
  /** One-line summary, suitable for a terminal. */
  message: string;
  /** Full captured stderr from the probe, when there was any. */
  detail?: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
  /** Collections this query attempted, whether or not they answered. */
  attempted: string[];
  /**
   * Collections that errored. EMPTY ARRAY IS THE ONLY THING THAT MAKES
   * `results: []` MEAN "empty". Non-empty here means the result set is
   * unverified — do not report it as an absence of prior work.
   */
  failures: KBQueryFailure[];
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
  },
): KBQueryResponse {
  const { agent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;
  // Normalize once at the top so every downstream path join, env var, and
  // ChromaDB collection name uses the canonical filesystem casing. Without
  // this, `shared-acmecorp` and `shared-AcmeCorp` become two
  // distinct ChromaDB collections and a case-drifted query silently hits
  // the wrong one.
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Determine which collections to query based on scope
  const collections: string[] = [];
  switch (scope) {
    case 'shared':
      collections.push(`shared-${org}`);
      break;
    case 'private':
      collections.push(agent ? `agent-${agent}` : `shared-${org}`);
      break;
    case 'all':
      collections.push(`shared-${org}`);
      if (agent) collections.push(`agent-${agent}`);
      break;
  }

  // UX safety net: if the KB is not configured for this org (no config.json
  // on disk yet), skip the python probe entirely and report every target
  // collection as unreachable. Previously the inner runQuery() try/catch would
  // swallow the Config-not-found error silently and the operator would see
  // "0 results" with no hint about WHY — indistinguishable from a legitimate
  // empty query against a configured KB.
  //
  // The warning alone was NOT enough: it goes to stderr while the "No results
  // found" line goes to stdout, so `RESULT=$(kb-query ...)` and any stdout-only
  // pipe still saw a clean, confident, wrong "nothing exists". Reporting these
  // as failures is what makes the distinction survive a pipe.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Reporting this as a FAILED query, not an empty one — run setup to enable.`,
    );
    return {
      results: [],
      total: 0,
      query: question,
      collection: `shared-${org}`,
      attempted: collections,
      failures: collections.map((c) => ({
        collection: c,
        message: `knowledge base not configured for org ${org} — run setup to enable`,
      })),
    };
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  /**
   * Reduce a python traceback to its last meaningful line, which is the
   * exception line and the only part an operator needs in a terminal. The full
   * text is preserved in `detail` and re-emitted to stderr by the caller —
   * summarising must never be the same thing as discarding.
   */
  const summarize = (stderr: string, fallback: string): string => {
    const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return fallback;
    return last.length > 300 ? `${last.slice(0, 300)}…` : last;
  };

  type ProbeResult =
    | { ok: true; output: string }
    | { ok: false; message: string; detail?: string };

  const runQuery = (col: string): ProbeResult => {
    try {
      const output = execFileSync(pythonPath, [
        mmragPath, 'query', question,
        '--collection', col,
        '--top-k', String(topK),
        '--threshold', String(threshold),
        '--json',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        env,
        // Capture stderr instead of letting it stream straight through. We
        // re-emit it below on failure; capturing is what lets us attach the
        // real cause to the failure record rather than leaving the operator to
        // correlate a loose traceback with a "no results" line.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, output };
    } catch (err) {
      const e = err as { stderr?: string | Buffer; message?: string; code?: string; signal?: string };
      const detail = e.stderr ? String(e.stderr) : '';
      // A killed-on-timeout probe reports no useful stderr, so name it
      // explicitly — a hung KB is a known live failure mode and it must not
      // read as a generic error.
      const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM';
      const message = timedOut
        ? `probe timed out after 30000ms`
        : summarize(detail, e.message || 'unknown error');
      // Re-emit the captured traceback so nothing that used to reach the
      // operator stops reaching them.
      if (detail) process.stderr.write(detail.endsWith('\n') ? detail : `${detail}\n`);
      return { ok: false, message, detail: detail || undefined };
    }
  };

  // A probe that exits 0 but emits something we cannot parse has NOT told us
  // the collection is empty — it has told us nothing. That is a failure, not a
  // zero. A well-formed `{"results": []}` is the genuine empty and parses fine.
  type ParseResult =
    | { ok: true; results: KBQueryResult[] }
    | { ok: false; message: string; detail?: string };

  const parseOutput = (output: string): ParseResult => {
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) {
      return {
        ok: false,
        message: 'probe returned no JSON payload',
        detail: trimmed || undefined,
      };
    }
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      return {
        ok: true,
        results: (raw.results || []).map((r) => ({
          content: r.content || r.result || '',
          source_file: r.source || '',
          org,
          agent_name: agent,
          score: r.similarity ?? 0,
          doc_type: r.type || 'markdown',
        })),
      };
    } catch (err) {
      return {
        ok: false,
        message: `probe returned malformed JSON: ${(err as Error).message}`,
        detail: trimmed,
      };
    }
  };

  const allResults: KBQueryResult[] = [];
  const failures: KBQueryFailure[] = [];
  let lastCollection = `shared-${org}`;

  for (const col of collections) {
    lastCollection = col;
    let probe: ProbeResult;
    try {
      probe = runQuery(col);
    } catch (err) {
      // Defensive: an unexpected throw is still a failure to answer, never an
      // empty collection. Recording it keeps the caller's exit code honest
      // instead of dumping a raw node stack over the results.
      failures.push({ collection: col, message: `unexpected error: ${(err as Error).message}` });
      continue;
    }
    if (!probe.ok) {
      failures.push({ collection: col, message: probe.message, detail: probe.detail });
      continue;
    }
    const parsed = parseOutput(probe.output);
    if (!parsed.ok) {
      failures.push({ collection: col, message: parsed.message, detail: parsed.detail });
      continue;
    }
    allResults.push(...parsed.results);
  }

  return {
    results: allResults,
    total: allResults.length,
    query: question,
    collection: collections.length === 1 ? lastCollection : `shared-${org}`,
    attempted: collections,
    failures,
  };
}

/**
 * Ingest files into the knowledge base.
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { agent, scope = 'shared', force, frameworkRoot, instanceId } = options;
  // Normalize once (see queryKnowledgeBase for rationale).
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Correctness fix: if the KB is not configured for this org, the underlying
  // python MMRAG tool exits with "Config not found. Run setup first" and
  // execFileSync (below, stdio: inherit) throws a non-zero-exit error. That
  // throw used to bubble up through the CLI action handler as an unhandled
  // exception, dumping a full Node stack trace on top of the python error
  // message — ugly and alarming for operators who were just running ingest
  // without setting up the KB first. Detect the missing-config state
  // up-front and warn-and-skip instead of letting execFileSync crash.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest — ` +
      `run setup to enable (see HEARTBEAT.md step 10 for the config path).`,
    );
    return;
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection name (same logic as kb-ingest.sh)
  let collection: string;
  if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }

  const args = [mmragPath, 'ingest', ...paths, '--collection', collection];
  if (force) args.push('--force');

  // Multimodal PDF ingestion via Gemini Flash routinely takes 2–5 min for
  // documents over ~10 pages with images/tables. Two minutes was too low and
  // produced ETIMEDOUT mid-Gemini-call. Default 10 min, override via env,
  // floored at 60s so nobody accidentally sets it to 0 or a value smaller
  // than a single Gemini call needs.
  const KB_INGEST_TIMEOUT_FLOOR_MS = 60_000;
  const KB_INGEST_TIMEOUT_DEFAULT_MS = 600_000;
  const requestedTimeout = Number(process.env.KB_INGEST_TIMEOUT_MS);
  const ingestTimeoutMs = Math.max(
    KB_INGEST_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : KB_INGEST_TIMEOUT_DEFAULT_MS,
  );

  execFileSync(pythonPath, args, {
    encoding: 'utf-8',
    timeout: ingestTimeoutMs,
    env,
    stdio: 'inherit',
  });

  console.log(`\nIngest complete → collection: ${collection}`);
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
