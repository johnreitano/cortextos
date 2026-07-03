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
//
// rmSyncFailureQueue lets individual tests inject a non-ENOENT rmSync
// failure for the NEXT call only (then reverts to real behavior) — used to
// test the "failed to revoke trust" and "corrupted file couldn't be
// removed" paths, neither of which is reachable by any real filesystem
// state we can portably construct in a test.
let callOrder: string[] = [];
const { rmSyncFailureQueue } = vi.hoisted(() => ({ rmSyncFailureQueue: [] as Array<Error> }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => {
    callOrder.push('rmSync');
    const injected = rmSyncFailureQueue.shift();
    if (injected) throw injected;
    return actual.rmSync(...args);
  } };
});
// execFileSyncFailOn lets a test force specific git subcommands to fail
// deterministically (matched by their first argv element, e.g. 'remove' or
// '-D') without needing to construct real git failure conditions — used for
// the "both rollback steps fail" case, which `git worktree lock` alone
// doesn't reliably produce for both commands simultaneously.
const { execFileSyncFailOn } = vi.hoisted(() => ({ execFileSyncFailOn: new Set<string>() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    callOrder.push(`execFileSync:${args[0]}:${(args[1] as string[])?.[0] || ''}`);
    const argv = (args[1] as string[]) || [];
    for (const marker of execFileSyncFailOn) {
      if (argv.includes(marker)) throw new Error(`injected failure for git ${argv.join(' ')}`);
    }
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

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { startTaskWorktree, finishTaskWorktree } from '../../../src/bus/task-worktree';
import { canonicalizePath, validateTaskWorktreeRecord } from '../../../src/hooks/index';
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
  rmSyncFailureQueue.length = 0;
  execFileSyncFailOn.clear();
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

  it('rolls back the worktree/branch if writing the state file fails after git worktree add succeeds', () => {
    // A plain file where the state directory needs to be makes
    // ensureDir(dirname(sp)) fail with ENOTDIR/EEXIST — simulating any
    // failure between worktree creation and state-file write (disk full,
    // permissions, etc.) without needing to mock fs.
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'state'), 'not a directory');

    expect(() => startTaskWorktree(agentDir, repo, 'demo')).toThrow(/Failed to record task worktree state/);

    // No orphaned worktree/branch left behind — rollback ran.
    const worktreeRoot = join(base, '.cortextos-task-worktrees', 'repo', 'demo');
    expect(existsSync(worktreeRoot)).toBe(false);
    const branches = execFileSync('git', ['branch', '--list', 'task/demo'], { cwd: repo, encoding: 'utf-8' });
    expect(branches.trim()).toBe('');
  });

  it('reports both failures distinctly when the rollback itself fails to remove the worktree AND delete the branch', () => {
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'state'), 'not a directory');
    execFileSyncFailOn.add('remove');
    execFileSyncFailOn.add('-D');

    let thrown: Error | undefined;
    try {
      startTaskWorktree(agentDir, repo, 'demo');
    } catch (err: any) {
      thrown = err;
    }
    expect(thrown?.message).toMatch(/worktree still exists at/);
    expect(thrown?.message).toMatch(/branch .* still exists/);
    expect(thrown?.message).not.toMatch(/undefined/);

    // Nothing was cleaned up — matches what the message claims.
    const worktreeRoot = join(base, '.cortextos-task-worktrees', 'repo', 'demo');
    expect(existsSync(worktreeRoot)).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', 'task/demo'], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain('demo');
  });

  it('reports only the branch as still-present when worktree removal succeeds but branch deletion fails during rollback', () => {
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'state'), 'not a directory');
    execFileSyncFailOn.add('-D'); // only branch deletion fails; worktree remove succeeds

    let thrown: Error | undefined;
    try {
      startTaskWorktree(agentDir, repo, 'demo');
    } catch (err: any) {
      thrown = err;
    }
    expect(thrown?.message).toMatch(/worktree removed/);
    expect(thrown?.message).toMatch(/branch .* still exists/);

    const worktreeRoot = join(base, '.cortextos-task-worktrees', 'repo', 'demo');
    expect(existsSync(worktreeRoot)).toBe(false); // actually removed — message must not claim otherwise
    const branches = execFileSync('git', ['branch', '--list', 'task/demo'], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain('demo'); // actually still present
  });

  // Note: there's no symmetric "worktree removal fails but branch deletion
  // succeeds" test — git itself refuses to delete a branch that's still
  // checked out in an existing worktree ("cannot delete branch ... used by
  // worktree at ..."), so if `git worktree remove` genuinely fails, the
  // subsequent `git branch -D` fails too as a real consequence, not an
  // independent outcome. That's exactly the "both fail" case already
  // covered above — this isn't a gap, it's git's own dependency between
  // the two operations.

  it('gives an actionable error, not a raw git failure, when the branch already exists (e.g. left over from a prior merge)', () => {
    // finishTaskWorktree's 'merge' path intentionally leaves the branch
    // behind (only the worktree checkout is removed) — so reusing the same
    // task name later is a realistic, not just theoretical, collision.
    execFileSync('git', ['branch', 'task/demo'], { cwd: repo });
    expect(() => startTaskWorktree(agentDir, repo, 'demo')).toThrow(/branch "task\/demo" already exists/);
  });

  it('still detects a pre-existing branch under a non-English git locale, and does not delete it', () => {
    // Regression test for a real bug: branch pre-existence used to be
    // inferred by pattern-matching git's English stderr text AFTER calling
    // `git worktree add`. Under a non-English locale, git's message differs
    // (verified: `LC_ALL=fr_FR.UTF-8` produces "Une branche nommée '...'
    // existe déjà", not "a branch named '...' already exists"), so the
    // regex never matched, execution fell through to the "git must have
    // created this, roll it back" path, and `git branch -D` force-deleted
    // the real, pre-existing branch. The fix checks existence with
    // `git rev-parse --verify` BEFORE calling `git worktree add` at all,
    // so no stderr text — in any language — is ever load-bearing here.
    execFileSync('git', ['branch', 'task/demo'], { cwd: repo });
    const originalLcAll = process.env.LC_ALL;
    const originalLanguage = process.env.LANGUAGE;
    process.env.LC_ALL = 'fr_FR.UTF-8';
    process.env.LANGUAGE = 'fr';
    try {
      expect(() => startTaskWorktree(agentDir, repo, 'demo')).toThrow(/branch "task\/demo" already exists/);
    } finally {
      if (originalLcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = originalLcAll;
      if (originalLanguage === undefined) delete process.env.LANGUAGE; else process.env.LANGUAGE = originalLanguage;
    }
    // The branch must survive — this is the actual regression being guarded.
    const branches = execFileSync('git', ['branch', '--list', 'task/demo'], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain('demo');
  });

  it('rolls back the branch git creates as a side effect when git worktree add fails for an unrelated reason (destination collision)', () => {
    // Verified empirically: `git worktree add <path> -b <branch>` creates
    // the branch BEFORE validating the destination, so a destination
    // collision still leaves the branch behind unless this code cleans it
    // up. This must NOT be confused with the "branch already exists" case
    // above — here the branch didn't exist before this call, git created
    // it and then failed for a different reason, and the fix (deleting the
    // branch) is actually appropriate here.
    //
    // A dangling symlink at the destination reproduces this while bypassing
    // startTaskWorktree's own `existsSync(worktreeRoot)` pre-check: Node's
    // existsSync follows symlinks and reports based on the target, so a
    // dangling symlink reads as "doesn't exist" — but git still refuses to
    // write into it ("fatal: '<path>' already exists") and, per empirical
    // verification, still creates the branch first.
    const worktreeParent = join(base, '.cortextos-task-worktrees', 'repo');
    mkdirSync(worktreeParent, { recursive: true });
    symlinkSync(join(base, 'nonexistent-target'), join(worktreeParent, 'demo'));

    let thrown: Error | undefined;
    try {
      startTaskWorktree(agentDir, repo, 'demo');
    } catch (err: any) {
      thrown = err;
    }
    expect(thrown?.message).toMatch(/Failed to create worktree at/);
    // Must NOT be misdiagnosed as the branch-already-exists case.
    expect(thrown?.message).not.toMatch(/branch "task\/demo" already exists/);

    // The branch git created as a side effect must be rolled back — not
    // left as an orphan that would misdiagnose every future retry as
    // "branch already exists" for what's actually a destination problem.
    const branches = execFileSync('git', ['branch', '--list', 'task/demo'], { cwd: repo, encoding: 'utf-8' });
    expect(branches.trim()).toBe('');
  });
});

describe('finishTaskWorktree', () => {
  it('throws when there is no active task', async () => {
    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge')).rejects.toThrow(/No active task/);
  });

  it('revokes trust even when the state file is corrupted, so the agent is not permanently stuck', async () => {
    startTaskWorktree(agentDir, repo, 'demo');
    // Corrupt it after the fact — truncated/malformed JSON, as if a crash
    // interrupted a write despite atomicWriteSync, or the file was hand-edited.
    writeFileSync(statePath(), '{ not valid json');

    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge'))
      .rejects.toThrow(/corrupted/);

    // Trust window closed regardless — the whole point of the fix. Without
    // it, this file would still exist and every subsequent start/finish
    // call would be permanently blocked.
    expect(existsSync(statePath())).toBe(false);
    // A fresh task can be started right away — proves the agent isn't stuck.
    expect(() => startTaskWorktree(agentDir, repo, 'second-task')).not.toThrow();
  });

  it('tells the truth when a corrupted state file also cannot be removed, instead of falsely claiming cleanup happened', async () => {
    startTaskWorktree(agentDir, repo, 'demo');
    writeFileSync(statePath(), '{ not valid json');
    rmSyncFailureQueue.push(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge'))
      .rejects.toThrow(/could NOT be removed.*trust window is still open/s);

    // Unlike the successful-removal case, the file is still there — the
    // thrown message's claim and reality must match, or an operator acting
    // on the (false) "already cleaned up" message would never look for it.
    expect(existsSync(statePath())).toBe(true);
  });

  it('reports the trust-revocation rmSync failure distinctly, not folded into a generic error', async () => {
    startTaskWorktree(agentDir, repo, 'demo');
    rmSyncFailureQueue.push(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    await expect(finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge'))
      .rejects.toThrow(/Failed to revoke task-worktree trust/);

    // The state file is still present — trust was genuinely NOT revoked,
    // matching what the error says. No git operation should have run since
    // the function must bail out at this point, before validation.
    expect(existsSync(statePath())).toBe(true);
  });

  it('rejects a record missing startedAt, even with every other field otherwise valid', () => {
    startTaskWorktree(agentDir, repo, 'demo');
    const { startedAt, ...withoutStartedAt } = JSON.parse(readFileSync(statePath(), 'utf-8'));
    expect(validateTaskWorktreeRecord(withoutStartedAt)).toBeNull();
    expect(validateTaskWorktreeRecord({ ...withoutStartedAt, startedAt: 12345 })).toBeNull();
    // Sanity: the same record WITH a valid startedAt does pass — isolates
    // the failure to startedAt specifically, not some other field.
    expect(validateTaskWorktreeRecord({ ...withoutStartedAt, startedAt })).not.toBeNull();
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

  it('falls back to "unavailable" for commits/diffStat, not a fabricated 0, when base-branch resolution fails', async () => {
    startTaskWorktree(agentDir, repo, 'demo');
    execFileSyncFailOn.add('symbolic-ref');
    try {
      const result = await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');
      expect(result.commits).toBeNull();
      expect(result.diffStat).toBe('(diff summary unavailable)');
      // The finish itself must still complete (worktree removed, approval
      // requested) — a failure to compute an approval-summary stat must
      // never block the actual git cleanup.
      expect(result.worktreeRemoved).toBe(true);
      expect(result.approvalId).toBeTruthy();
    } finally {
      execFileSyncFailOn.delete('symbolic-ref');
    }
  });

  it('reports commits as null (not a fabricated 0) when git rev-list fails, but still computes diffStat', async () => {
    const { path: worktreePath } = startTaskWorktree(agentDir, repo, 'demo');
    writeFileSync(join(worktreePath, 'feature.txt'), 'new feature');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: worktreePath });
    execFileSyncFailOn.add('rev-list');
    try {
      const result = await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');
      expect(result.commits).toBeNull();
      expect(result.diffStat).not.toBe('(diff summary unavailable)');
    } finally {
      execFileSyncFailOn.delete('rev-list');
    }
  });

  it('falls back to "(diff summary unavailable)" when git diff --stat fails, but still reports commit count', async () => {
    const { path: worktreePath } = startTaskWorktree(agentDir, repo, 'demo');
    writeFileSync(join(worktreePath, 'feature.txt'), 'new feature');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: worktreePath });
    execFileSyncFailOn.add('diff');
    try {
      const result = await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');
      expect(result.commits).toBe(1);
      expect(result.diffStat).toBe('(diff summary unavailable)');
    } finally {
      execFileSyncFailOn.delete('diff');
    }
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

  it('strips Markdown-significant characters from the repo path too, not just branch', async () => {
    // POSIX directory names can legally contain backtick/paren/underscore —
    // nothing about the repo-directory charset is restricted the way
    // taskName is, so this needs the same sanitization treatment.
    const dangerousRepo = join(base, 'repo`evil`(x)_y');
    mkdirSync(dangerousRepo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dangerousRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dangerousRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dangerousRepo });
    writeFileSync(join(dangerousRepo, 'README.md'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: dangerousRepo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dangerousRepo });

    startTaskWorktree(agentDir, dangerousRepo, 'demo');
    createApprovalSpy.mockClear();
    await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'merge');

    expect(createApprovalSpy).toHaveBeenCalledTimes(1);
    const [, , , , , context] = createApprovalSpy.mock.calls[0];
    expect(context).not.toContain(dangerousRepo);
    expect(context).not.toMatch(/`/);
  });
});
