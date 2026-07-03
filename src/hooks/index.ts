/**
 * Shared utility functions for Claude Code hook scripts.
 * Each hook reads JSON from stdin, processes it, and writes JSON to stdout.
 */

import { readFileSync, existsSync, watch, statSync, unlinkSync, mkdirSync, realpathSync, lstatSync } from 'fs';
import { join, resolve, sep, dirname, basename } from 'path';
import { homedir } from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

/**
 * Read all data from stdin as a string.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer<ArrayBufferLike>[] = [];
    process.stdin.on('data', (chunk: Buffer<ArrayBufferLike>) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Parse hook input JSON into tool_name and tool_input.
 */
export function parseHookInput(input: string): { tool_name: string; tool_input: any } {
  try {
    const parsed = JSON.parse(input);
    return {
      tool_name: parsed.tool_name || 'unknown',
      tool_input: parsed.tool_input || {},
    };
  } catch {
    return { tool_name: 'unknown', tool_input: {} };
  }
}

/**
 * Load environment variables for hook scripts.
 * Reads BOT_TOKEN and CHAT_ID from .env file in cwd or CTX_AGENT_DIR.
 */
export function loadEnv(): {
  botToken?: string;
  chatId?: string;
  agentName: string;
  stateDir: string;
  ctxRoot: string;
} {
  const agentName = process.env.CTX_AGENT_NAME || require('path').basename(process.cwd());
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
  const stateDir = join(ctxRoot, 'state', agentName);

  // Try to load .env file
  const envPaths = [
    process.env.CTX_AGENT_DIR ? join(process.env.CTX_AGENT_DIR, '.env') : null,
    join(process.cwd(), '.env'),
  ].filter(Boolean) as string[];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }

  return {
    botToken: process.env.BOT_TOKEN,
    chatId: process.env.CHAT_ID,
    agentName,
    stateDir,
    ctxRoot,
  };
}

/**
 * Write a PermissionRequest decision to stdout and exit.
 */
export function outputDecision(behavior: 'allow' | 'deny', message?: string): void {
  const decision: any = { behavior };
  if (message) decision.message = message;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
    },
  };

  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(0);
}

/**
 * Generate a unique hex ID for hook requests.
 */
export function generateId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Wait for a response file to appear, using fs.watch with a poll fallback.
 * Returns the file content or null on timeout.
 */
export function waitForResponseFile(filePath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const dir = require('path').dirname(filePath);
    const fileName = require('path').basename(filePath);

    mkdirSync(dir, { recursive: true });

    let resolved = false;
    let watcher: ReturnType<typeof watch> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (watcher) { try { watcher.close(); } catch {} }
      if (pollInterval) clearInterval(pollInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const checkFile = () => {
      if (resolved) return;
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          cleanup();
          resolve(content);
        }
      } catch {
        // File might be mid-write, try again next poll
      }
    };

    // Check immediately
    checkFile();
    if (resolved) return;

    // Set up fs.watch
    try {
      watcher = watch(dir, (eventType: string, filename: string | null) => {
        if (filename === fileName || !filename) {
          checkFile();
        }
      });
      watcher.on('error', () => {
        // Fall through to poll
      });
    } catch {
      // fs.watch not available, poll only
    }

    // Poll fallback every 2 seconds
    pollInterval = setInterval(checkFile, 2000);

    // Timeout
    timeoutHandle = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Format a tool summary for human-readable display.
 */
export function formatToolSummary(toolName: string, toolInput: any): string {
  switch (toolName) {
    case 'Edit': {
      const filePath = toolInput.file_path || 'unknown';
      const oldStr = String(toolInput.old_string || '').slice(0, 300);
      const newStr = String(toolInput.new_string || '').slice(0, 300);
      return `File: ${filePath}\n\n- ${oldStr}\n+ ${newStr}`;
    }
    case 'Write': {
      const filePath = toolInput.file_path || 'unknown';
      const content = String(toolInput.content || '').slice(0, 300);
      return `File: ${filePath}\n\n${content}`;
    }
    case 'Bash': {
      // Show enough of the command for the human approver to judge it. A 200-char
      // cap let a benign-looking prefix hide a malicious payload past the cut
      // (#39); the message-level cap still bounds Telegram length. Mark truncation
      // explicitly so the reviewer knows more of the command will run.
      const command = String(toolInput.command || '');
      const shown = command.slice(0, 1500);
      const more = command.length > shown.length ? '\n…(preview truncated — the FULL command, not just this preview, runs if you approve)' : '';
      return `Command: ${shown}${more}`;
    }
    default: {
      return JSON.stringify(toolInput).slice(0, 200);
    }
  }
}

/**
 * Whether a tool operation may be auto-approved because it edits the agent's
 * OWN `.claude/` directory (config/skills the agent legitimately manages at
 * runtime). Under `bypassPermissions` this hook is the only approval gate, so
 * this check must be precise — not a substring match.
 *
 * - Bash is NEVER auto-approved: a shell command string cannot be proven to act
 *   solely within `.claude/` (e.g. `rm -rf ~; ls .claude/` contains the
 *   substring), so it always goes to the human gate (#1/#15).
 * - Edit/Write is auto-approved only when the file_path, resolved to an
 *   absolute normalized path, is genuinely contained within THIS agent's
 *   `<agentDir>/.claude/` — defeating `..` traversal and other agents' /
 *   arbitrary `.claude/` directories (#18).
 *
 * Symlinks are resolved on the deepest existing ancestor (the Write target
 * itself may not exist yet), so a symlink inside `.claude` that points out of
 * the tree cannot be used to escape — matching the shell hook's `realpath -m`.
 * A symlinked `.claude` root is rejected outright (it would redirect the gate
 * to an arbitrary directory). There is NO cwd fallback: without an explicit
 * agent-dir trust boundary the operation is not auto-approved.
 *
 * @param agentDir Base directory of the agent. Defaults to CTX_AGENT_DIR; if
 *   neither is available, returns false (the request goes to the human gate).
 */
export function isClaudeDirOperation(
  toolName: string,
  toolInput: any,
  agentDir?: string,
): boolean {
  if (toolName !== 'Edit' && toolName !== 'Write') return false;
  const filePath = toolInput?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return false;

  // Require an explicit trust boundary — never fall back to cwd, which would let
  // the auto-approve scope drift to whatever directory the hook started in.
  const base = agentDir ?? process.env.CTX_AGENT_DIR;
  if (!base) return false;

  // Canonicalize the agent dir first (resolves legitimate symlinks on the install
  // path, e.g. /tmp -> /private/tmp), so the .claude subtree below it is the only
  // thing left to vet.
  const canonAgentDir = canonicalizePath(resolve(base));
  const claudeRoot = join(canonAgentDir, '.claude');
  const target = canonicalizePath(resolve(canonAgentDir, filePath));

  // Lexical containment within the agent's own .claude/.
  if (target !== claudeRoot && !target.startsWith(claudeRoot + sep)) return false;

  // Reject if any component at or below .claude is a symlink — live OR dangling.
  // A planted symlink could otherwise redirect an "inside .claude" write out of
  // the tree. We lstat each component because realpathSync can't observe a
  // *dangling* symlink (it throws, and canonicalize would fall back to lexical).
  return !hasSymlinkComponent(canonAgentDir, target);
}

/**
 * Whether any path component strictly below `rootDir` (assumed already
 * canonical) up to and including `target` is a symlink (live or dangling).
 * Stops at the first non-existent component — a name that doesn't exist yet
 * cannot be a symlink, and deeper components can't exist under it.
 */
function hasSymlinkComponent(rootDir: string, target: string): boolean {
  if (!target.startsWith(rootDir + sep)) return false;
  const rel = target.slice(rootDir.length + 1);
  let cur = rootDir;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      break;
    }
  }
  return false;
}

/**
 * Canonicalize an absolute path, resolving symlinks. Because the target may not
 * exist yet (e.g. a Write that creates a new file), we realpath the deepest
 * existing ancestor — which resolves any symlinked component — then re-append
 * the non-existent tail. Falls back to the lexical path if nothing exists.
 */
export function canonicalizePath(p: string): string {
  let dir = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return p; // reached fs root, nothing on the path exists
      tail.push(basename(dir));
      dir = parent;
    }
  }
}

export interface ActiveTaskWorktree {
  path: string;
  branch: string;
  repo: string;
  taskName: string;
  startedAt: string;
}

/**
 * Fixed, repo-derived worktree location for a task — the ONE formula both
 * the writer (`startTaskWorktree`, src/bus/task-worktree.ts) and the reader
 * (`validateTaskWorktreeRecord` below) use, so the taskName<->path
 * invariant can't silently drift by editing one copy and not the other.
 * `resolvedRepo` must already be canonicalized by the caller. Only the
 * final path segment (`taskName`) is agent-supplied, and it must already
 * have passed the letters/numbers/hyphen/underscore check
 * (`startTaskWorktree` enforces this at write time, `validateTaskWorktreeRecord`
 * at read time) before reaching here — this function does not re-validate it.
 */
export function worktreeRootFor(resolvedRepo: string, taskName: string): string {
  return join(dirname(resolvedRepo), '.cortextos-task-worktrees', basename(resolvedRepo), taskName);
}

/**
 * Validate an already-parsed task-worktree record. Returns null if:
 * - it's malformed (missing/wrong-typed field, including `startedAt`)
 * - its `taskName` contains characters outside `[a-zA-Z0-9_-]`
 * - it names main/master as its branch
 * - its `repo` isn't a git repository root
 * - `git worktree list` can't be run against `repo` (operational failure)
 * - its `path` doesn't match the expected location for its own `taskName`
 *   (see `worktreeRootFor`)
 * - that path isn't currently a registered worktree at all
 * - that worktree is detached (no branch checked out)
 * - its `branch` doesn't match the branch actually checked out at that path
 *
 * This is the ONE validator used on every read of
 * `.claude/state/active-task-worktree.json`, by both the permission hook
 * (`getActiveTaskWorktree` below) and `finishTaskWorktree`
 * (src/bus/task-worktree.ts). It exists because, although
 * `cortextos bus task-worktree start` is the only code path INTENDED to
 * write this file, nothing stops an agent from writing it directly — it
 * lives inside the already-trusted `.claude/` tree. Validating a record
 * in one reader but not the other would leave the unvalidated reader
 * trusting an agent-supplied path/branch/repo outright; sharing this
 * function is what closes that gap for both.
 *
 * Every field that can be cross-referenced against reality IS
 * cross-referenced, deliberately: verifying `path` alone isn't enough,
 * because a record could keep a real, previously-verified `path` but swap
 * in an unrelated `branch` — e.g. to make `finishTaskWorktree`'s
 * `git branch -D` on the abandon path force-delete an arbitrary branch
 * that has nothing to do with the sanctioned worktree — or an unrelated
 * `taskName`, misleading whoever reads it in the human-facing
 * merge-approval text about what's actually being merged. `path` is
 * required to be the EXACT location `worktreeRootFor` would derive for
 * `record.taskName`, and `branch` is required to equal what
 * `git worktree list` reports for that exact path.
 *
 * Every rejection is logged (stderr — stdout is reserved for the hook's
 * JSON decision protocol) so a legitimate operational failure (git
 * timeout, lock file, corrupted repo) isn't indistinguishable from an
 * actual tampered record when someone's troubleshooting `finish`. Trust
 * is fail-closed either way; logging the reason costs nothing security-wise.
 */
export function validateTaskWorktreeRecord(record: any): ActiveTaskWorktree | null {
  if (
    !record ||
    typeof record.path !== 'string' ||
    typeof record.repo !== 'string' ||
    typeof record.branch !== 'string' ||
    typeof record.taskName !== 'string' ||
    typeof record.startedAt !== 'string'
  ) {
    console.error('task-worktree: rejecting record — missing or wrong-typed field(s)');
    return null;
  }
  // Same charset `startTaskWorktree` enforces at write time — re-applied
  // here because taskName is otherwise never cross-checked against
  // anything (unlike path/branch/repo), and it's interpolated into a
  // human-facing Telegram approval message. Restricting it to
  // letters/numbers/hyphens/underscores rules out Markdown control
  // characters (backticks, brackets, parens, asterisks) at the source,
  // rather than trying to escape them at every display site.
  if (!/^[a-zA-Z0-9_-]+$/.test(record.taskName)) {
    console.error('task-worktree: rejecting record — taskName contains disallowed characters');
    return null;
  }
  // Independently of the path/branch cross-check below: never grant
  // task-worktree trust to a record naming main/master as its branch, even
  // if some future change loosens the other checks — editing/Bash-ing
  // against the repo's mainline branch must never ride on this trust grant.
  if (record.branch === 'main' || record.branch === 'master') {
    console.error(`task-worktree: rejecting record — branch is ${record.branch}`);
    return null;
  }

  const canonRepo = canonicalizePath(resolve(record.repo));
  if (!existsSync(join(canonRepo, '.git'))) {
    console.error(`task-worktree: rejecting record — repo is not a git repository root: ${canonRepo}`);
    return null;
  }
  // Pinned to taskName, not just the repo's task-worktrees root — otherwise
  // a record could pair a real, legitimately-registered worktree's path
  // with an unrelated taskName, misleading whoever reads the taskName in
  // the human-facing merge-approval text about what's actually being
  // merged. Uses the SAME worktreeRootFor the writer uses (not a hand-
  // mirrored copy of its formula) so the invariant can't silently drift.
  const expectedPath = worktreeRootFor(canonRepo, record.taskName);
  const canonPath = canonicalizePath(resolve(record.path));
  if (canonPath !== expectedPath) {
    console.error(`task-worktree: rejecting record — path does not match the expected location for taskName "${record.taskName}"`);
    return null;
  }

  let foundPath = false;
  let actualBranch: string | null = null;
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: canonRepo, encoding: 'utf-8', timeout: 10000,
    });
    for (const block of list.split('\n\n')) {
      const pathMatch = block.match(/^worktree (.+)$/m);
      if (!pathMatch || canonicalizePath(resolve(pathMatch[1])) !== canonPath) continue;
      foundPath = true;
      const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
      actualBranch = branchMatch ? branchMatch[1] : null;
      break;
    }
  } catch (err: any) {
    console.error(`task-worktree: rejecting record — failed to run git worktree list: ${err.message || err}`);
    return null;
  }
  // "Not registered at all" and "registered but detached" are distinct
  // failure classes with different causes (stale/fabricated record vs.
  // something manually checking out a commit inside a live worktree) —
  // logged separately so troubleshooting `finish` doesn't have to guess
  // which one happened.
  if (!foundPath) {
    console.error(`task-worktree: rejecting record — path is not a currently registered git worktree of ${canonRepo}`);
    return null;
  }
  if (actualBranch === null) {
    console.error(`task-worktree: rejecting record — path is a registered worktree of ${canonRepo} but is detached (no branch checked out)`);
    return null;
  }
  if (actualBranch !== record.branch) {
    console.error(
      `task-worktree: rejecting record — branch mismatch: record says "${record.branch}", the worktree is actually on "${actualBranch}"`,
    );
    return null;
  }

  return { path: canonPath, branch: actualBranch, repo: canonRepo, taskName: record.taskName, startedAt: record.startedAt };
}

/**
 * Read and validate the active task-worktree record for an agent, if any.
 * Returns null if there is no active task, the file can't be read/parsed,
 * or the record fails any of `validateTaskWorktreeRecord`'s checks — see
 * that function's docstring for the full enumerated list.
 */
export function getActiveTaskWorktree(agentDir: string): ActiveTaskWorktree | null {
  const statePath = join(agentDir, '.claude', 'state', 'active-task-worktree.json');
  if (!existsSync(statePath)) return null;

  let record: any;
  try {
    record = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch (err: any) {
    console.error(`task-worktree: rejecting record — failed to read/parse ${statePath}: ${err.message || err}`);
    return null;
  }
  return validateTaskWorktreeRecord(record);
}

/**
 * Whether a tool call is confined to the agent's currently active, verified
 * task worktree (see `cortextos bus task-worktree start`/`finish`).
 *
 * Edit/Write are checked for path containment exactly like
 * isClaudeDirOperation. Bash is NOT — Claude Code's Bash tool carries no
 * per-call working directory, and this hook runs as a stateless subprocess
 * per call, so there's no reliable signal to confine a shell command to the
 * worktree. A scoped/allowlisted Bash was considered and rejected: neither
 * a cwd check (no signal to check) nor a command allowlist (defeatable by
 * shell metacharacters) can actually enforce containment, so while a task is
 * active, Bash is trusted unconditionally — a deliberate, wider trust grant
 * accepted for the task's duration. Calling `task-worktree finish` deletes
 * the state file BEFORE computing anything else, closing this window
 * immediately — so a subsequent merge/deploy step always goes through the
 * normal Telegram gate.
 */
export function isTaskWorktreeOperation(
  toolName: string,
  toolInput: any,
  agentDir?: string,
): boolean {
  const base = agentDir ?? process.env.CTX_AGENT_DIR;
  if (!base) return false;
  const active = getActiveTaskWorktree(resolve(base));
  if (!active) return false;

  if (toolName === 'Bash') return true;

  if (toolName !== 'Edit' && toolName !== 'Write') return false;
  const filePath = toolInput?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return false;

  const target = canonicalizePath(resolve(active.path, filePath));
  if (target !== active.path && !target.startsWith(active.path + sep)) return false;
  return !hasSymlinkComponent(active.path, target);
}

/**
 * Sanitize text for use inside Telegram code blocks.
 * Escapes triple backticks.
 */
export function sanitizeCodeBlock(text: string): string {
  return text.replace(/```/g, '``\\`');
}

/**
 * Build an inline keyboard for Telegram permission requests.
 */
export function buildPermissionKeyboard(uniqueId: string): object {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `perm_allow_${uniqueId}` },
      { text: 'Deny', callback_data: `perm_deny_${uniqueId}` },
    ]],
  };
}

/**
 * Build an inline keyboard for Telegram plan review.
 */
export function buildPlanKeyboard(uniqueId: string): object {
  return {
    inline_keyboard: [[
      { text: 'Approve Plan', callback_data: `perm_allow_${uniqueId}` },
      { text: 'Deny Plan', callback_data: `perm_deny_${uniqueId}` },
    ]],
  };
}

/**
 * Build keyboard for ask-question (single-select).
 */
export function buildAskSingleSelectKeyboard(
  questionIdx: number,
  options: string[],
): object {
  return {
    inline_keyboard: options.map((label, optIdx) => [
      { text: label, callback_data: `askopt_${questionIdx}_${optIdx}` },
    ]),
  };
}

/**
 * Build keyboard for ask-question (multi-select).
 */
export function buildAskMultiSelectKeyboard(
  questionIdx: number,
  options: string[],
): object {
  return {
    inline_keyboard: [
      ...options.map((label, optIdx) => [
        { text: label, callback_data: `asktoggle_${questionIdx}_${optIdx}` },
      ]),
      [{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }],
    ],
  };
}

/**
 * Build ask-state structure from questions array.
 */
export function buildAskState(questions: any[]): object {
  return {
    questions: questions.map((q) => ({
      question: q.question,
      header: q.header || '',
      multiSelect: q.multiSelect || false,
      options: (q.options || []).map((o: any) => o.label || o),
    })),
    current_question: 0,
    total_questions: questions.length,
    multi_select_chosen: [],
  };
}

/**
 * Format a question message for Telegram.
 */
export function formatQuestionMessage(
  agentName: string,
  questionIdx: number,
  totalQuestions: number,
  question: any,
): string {
  let msg = totalQuestions > 1
    ? `QUESTION (${questionIdx + 1}/${totalQuestions}) - ${agentName}:`
    : `QUESTION - ${agentName}:`;

  const header = question.header || '';
  if (header) {
    msg += `\n${header}`;
  }
  msg += `\n${question.question}\n`;

  if (question.multiSelect) {
    msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
  }

  const options = question.options || [];
  for (let i = 0; i < options.length; i++) {
    const label = options[i].label || options[i];
    msg += `\n${i + 1}. ${label}`;
    const desc = options[i].description;
    if (desc) {
      msg += `\n   ${desc}`;
    }
  }

  return msg;
}

/**
 * Cleanup a response file, ignoring errors.
 */
export function cleanupResponseFile(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}
