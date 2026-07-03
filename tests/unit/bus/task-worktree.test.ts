import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const postActivitySpy = vi.fn().mockResolvedValue(true);
vi.mock('../../../src/bus/system', () => ({
  postActivity: (...args: unknown[]) => postActivitySpy(...args),
}));
vi.mock('../../../src/bus/message', () => ({
  sendMessage: vi.fn(),
}));

const telegramSendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
vi.mock('../../../src/telegram/api', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return telegramSendMessageSpy(...args);
    }
  },
}));

// Records call order across the real 'fs'/'child_process' modules so the
// "state file deleted before any git command" guarantee can be verified by
// actual call sequence, not by timing relative to `await` — everything in
// finishTaskWorktree up to its first await runs synchronously in one tick,
// so checking existsSync() right after calling (without awaiting) can't
// distinguish "deleted first" from "deleted last, still before the await."
let callOrder: string[] = [];
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => {
    callOrder.push('rmSync');
    return actual.rmSync(...args);
  } };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    callOrder.push(`execFileSync:${args[0]}:${(args[1] as string[])?.[0] || ''}`);
    return actual.execFileSync(...args);
  } };
});

// A controllable spy wrapping the real createApproval — defaults to calling
// through, but individual tests can `.mockImplementationOnce` a throw to
// verify finishTaskWorktree doesn't lose its cleanup-status context when
// approval creation itself fails. vi.hoisted() is required here (unlike the
// plain `const` used for the fs/child_process wrappers above) because the
// factory below assigns a default implementation eagerly, at module-load
// time — referencing a plain top-level `const` from inside a hoisted
// vi.mock factory would throw a TDZ error since imports (which trigger the
// factory) are hoisted above regular `const` declarations.
const { createApprovalSpy } = vi.hoisted(() => ({ createApprovalSpy: vi.fn() }));
vi.mock('../../../src/bus/approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/approval')>();
  createApprovalSpy.mockImplementation((...args: Parameters<typeof actual.createApproval>) => actual.createApproval(...args));
  return { ...actual, createApproval: (...args: any[]) => createApprovalSpy(...args) };
});

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { startTaskWorktree, finishTaskWorktree } from '../../../src/bus/task-worktree';
import { canonicalizePath } from '../../../src/hooks/index';
import type { BusPaths } from '../../../src/types';

let base: string;
let repo: string;
let agentDir: string;
let paths: BusPaths;

function mkPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'orgs', 'TestOrg', 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
}

function statePath(): string {
  return join(agentDir, '.claude', 'state', 'active-task-worktree.json');
}

beforeEach(() => {
  // Canonicalized immediately — startTaskWorktree canonicalizes the repo
  // path too (so its worktree-path basename matches what
  // validateTaskWorktreeRecord re-derives on every read), which on macOS
  // means tmpdir()'s /var/folders/... resolves to /private/var/folders/....
  // Comparing against a canonicalized `base` throughout keeps every
  // downstream path assertion consistent with what the code actually does.
  base = canonicalizePath(mkdtempSync(join(tmpdir(), 'cortextos-taskwt-test-')));
  repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  agentDir = join(base, 'agent');
  mkdirSync(join(agentDir, '.claude'), { recursive: true });

  paths = mkPaths(join(base, 'ctxroot'));
  postActivitySpy.mockClear();
  telegramSendMessageSpy.mockClear();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('startTaskWorktree', () => {
  it('creates a worktree at the fixed convention path and writes the state file', () => {
    const result = startTaskWorktree(agentDir, repo, 'demo');
    expect(result.branch).toBe('task/demo');
    expect(result.path).toBe(join(base, '.cortextos-task-worktrees', 'repo', 'demo'));
    expect(existsSync(result.path)).toBe(true);

    const state = JSON.parse(readFileSync(statePath(), 'utf-8'));
    expect(state.repo).toBe(repo);
    expect(state.path).toBe(result.path);
    expect(state.branch).toBe('task/demo');
    expect(state.taskName).toBe('demo');
  });

  it('accepts a custom branch name', () => {
    const result = startTaskWorktree(agentDir, repo, 'demo', 'feature/custom');
    expect(result.branch).toBe('feature/custom');
  });

  it('rejects a task name with unsafe characters', () => {
    expect(() => startTaskWorktree(agentDir, repo, '../escape')).toThrow(/letters, numbers, hyphens/);
  });

  it('rejects main/master as the branch name', () => {
    expect(() => startTaskWorktree(agentDir, repo, 'demo', 'main')).toThrow(/main\/master/);
  });

  it('refuses a non-git-repo path', () => {
    const notRepo = join(base, 'not-a-repo');
    mkdirSync(notRepo, { recursive: true });
    expect(() => startTaskWorktree(agentDir, notRepo, 'demo')).toThrow(/Not a git repository/);
  });

  it('refuses to start a second task while one is already active', () => {
    startTaskWorktree(agentDir, repo, 'first');
    expect(() => startTaskWorktree(agentDir, repo, 'second')).toThrow(/already active/);
  });

  it('refuses a task name whose worktree path already exists', () => {
    const clashPath = join(base, '.cortextos-task-worktrees', 'repo', 'demo');
    mkdirSync(clashPath, { recursive: true });
    expect(() => startTaskWorktree(agentDir, repo, 'demo')).toThrow(/already exists/);
  });
});

describe('finishTaskWorktree', () => {
  it('throws when there is no active task', async () => {
    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge')).rejects.toThrow(/No active task/);
  });

  it('deletes the state file before doing anything else, closing the trust window immediately', async () => {
    const { path: worktreePath } = startTaskWorktree(agentDir, repo, 'demo');
    expect(existsSync(statePath())).toBe(true);
    const resultPromise = finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');
    // The state file must already be gone synchronously, before the async
    // approval-creation work even starts.
    expect(existsSync(statePath())).toBe(false);
    await resultPromise;
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('calls rmSync on the state file before any git command runs — the actual load-bearing ordering guarantee', async () => {
    startTaskWorktree(agentDir, repo, 'demo');
    callOrder = []; // only care about calls made by this finishTaskWorktree invocation
    await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');
    expect(callOrder[0]).toBe('rmSync');
    expect(callOrder.slice(1).every(c => c.startsWith('execFileSync'))).toBe(true);
  });

  it('removes the worktree and requests a merge approval by default', async () => {
    const { path: worktreePath, branch } = startTaskWorktree(agentDir, repo, 'demo');
    writeFileSync(join(worktreePath, 'feature.txt'), 'new feature');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: worktreePath });

    const result = await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');
    expect(existsSync(worktreePath)).toBe(false);
    expect(result.commits).toBe(1);
    expect(result.approvalId).toBeTruthy();
    expect(result.worktreeRemoved).toBe(true);
    // Branch itself must survive a 'merge' finish — only the worktree checkout is removed.
    const branches = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain(branch.replace('task/', ''));
  });

  it('deletes the branch on abandon and does not request approval', async () => {
    const { path: worktreePath, branch } = startTaskWorktree(agentDir, repo, 'demo');
    const result = await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'abandon');
    expect(existsSync(worktreePath)).toBe(false);
    expect(result.approvalId).toBeUndefined();
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf-8' });
    expect(branches.trim()).toBe('');
  });

  it('refuses to run any git operation against a tampered state file, even though the trust window is still revoked', async () => {
    const { path: worktreePath, branch } = startTaskWorktree(agentDir, repo, 'demo');
    // Hand-craft the record to name main as its branch — exactly the kind
    // of tampering validateTaskWorktreeRecord exists to catch. Everything
    // else about the record is otherwise "valid-looking."
    writeFileSync(statePath(), JSON.stringify({
      repo, path: worktreePath, branch: 'main', taskName: 'demo', startedAt: new Date().toISOString(),
    }));

    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'abandon'))
      .rejects.toThrow(/failed validation/);

    // Trust window closed regardless (state file gone)...
    expect(existsSync(statePath())).toBe(false);
    // ...but no destructive git operation ran: the worktree and its real
    // branch (task/demo, not the tampered "main") are untouched.
    expect(existsSync(worktreePath)).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain('demo');
  });

  it('refuses a record whose repo does not match where the worktree was actually registered', async () => {
    const { path: worktreePath } = startTaskWorktree(agentDir, repo, 'demo');
    const otherRepo = join(base, 'other-repo');
    mkdirSync(otherRepo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: otherRepo });
    writeFileSync(statePath(), JSON.stringify({
      repo: otherRepo, path: worktreePath, branch: 'task/demo', taskName: 'demo', startedAt: new Date().toISOString(),
    }));

    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'abandon'))
      .rejects.toThrow(/failed validation/);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('refuses a record whose branch does not match the branch actually checked out at that path', async () => {
    const { path: worktreePath } = startTaskWorktree(agentDir, repo, 'demo');
    // A second, real branch that exists in the repo but has nothing to do
    // with this worktree — the exact scenario the branch/path cross-check
    // exists to catch: path and repo are genuinely valid, only branch lies.
    execFileSync('git', ['branch', 'someone-elses-branch'], { cwd: repo });
    writeFileSync(statePath(), JSON.stringify({
      repo, path: worktreePath, branch: 'someone-elses-branch', taskName: 'demo', startedAt: new Date().toISOString(),
    }));

    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'abandon'))
      .rejects.toThrow(/failed validation/);

    // Neither the real worktree branch nor the tampered-target branch was deleted.
    const branches = execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain('demo');
    expect(branches).toContain('someone-elses-branch');
  });

  it('surfaces worktreeRemoved/branchDeleted as false, without throwing, when git commands fail', async () => {
    const { path: worktreePath, branch } = startTaskWorktree(agentDir, repo, 'demo');
    // A locked worktree makes both `git worktree remove` and (since it's
    // still checked out) the follow-on `git branch -D` fail deterministically.
    execFileSync('git', ['worktree', 'lock', worktreePath], { cwd: repo });

    const result = await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'abandon');
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    // Nothing was silently cleaned up — both survive on disk for manual recovery.
    expect(existsSync(worktreePath)).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain('demo');

    execFileSync('git', ['worktree', 'unlock', worktreePath], { cwd: repo });
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repo });
  });

  it('does not lose cleanup-status context when createApproval throws', async () => {
    startTaskWorktree(agentDir, repo, 'demo');
    createApprovalSpy.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge'))
        .rejects.toThrow(/disk full/);
      // The cleanup that already happened (trust revoked, worktree removed)
      // must be logged even though the approval — and thus the return
      // value — never materializes.
      const logged = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(logged).toMatch(/failed to create merge approval/);
      expect(logged).toMatch(/worktreeRemoved=true/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('strips Markdown-significant characters from branch/repo before they reach the approval message', async () => {
    // Git itself allows backtick/parens/underscore in ref names (verified:
    // `git check-ref-format --branch` accepts this string) — so a real,
    // legitimately-registered branch can still carry characters that would
    // otherwise let it break out of a Markdown code span or inject a link
    // in the Telegram-rendered approval text.
    const dangerousBranch = 'feature`evil`(x)_y';
    startTaskWorktree(agentDir, repo, 'demo', dangerousBranch);

    createApprovalSpy.mockClear(); // createApprovalSpy is module-level and shared across tests
    await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');

    expect(createApprovalSpy).toHaveBeenCalledTimes(1);
    const [, , , title, , context] = createApprovalSpy.mock.calls[0];
    for (const text of [title, context]) {
      // The message template itself legitimately uses parens/quotes for
      // structure — check the DANGEROUS value doesn't survive intact and
      // that backtick specifically (never used by the template itself)
      // is gone, rather than banning every bracket/paren in the whole string.
      expect(text).not.toContain(dangerousBranch);
      expect(text).not.toMatch(/`/);
    }
    // Sanitization doesn't just delete the whole value — the safe parts survive.
    expect(title).toContain('featureevilxy');
  });
});
