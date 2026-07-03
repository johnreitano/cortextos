/**
 * Task worktrees — an isolated, git-tracked sandbox an agent can work in
 * without triggering a Telegram approval round-trip on every tool call.
 *
 * The hook in src/hooks/index.ts (isTaskWorktreeOperation) trusts a task
 * worktree's own file tree for Edit/Write, and trusts Bash unconditionally
 * for the lifetime of the task (see that file's doc comment for why Bash
 * can't be scoped to the worktree the way Edit/Write can). `startTaskWorktree`
 * below is the only code path INTENDED to create the state file that grants
 * that trust — but nothing stops an agent from writing it directly, since it
 * lives inside the already-trusted `.claude/` tree. Nothing here relies on
 * that not happening: both this module's `finishTaskWorktree` and the hook's
 * `getActiveTaskWorktree` validate every record they read through the same
 * `validateTaskWorktreeRecord` (src/hooks/index.ts) before trusting any of
 * its fields — so a hand-crafted record fails safe on both read paths, not
 * just one.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { createApproval } from './approval.js';
import { validateTaskWorktreeRecord, canonicalizePath } from '../hooks/index.js';
import type { BusPaths } from '../types/index.js';

interface TaskWorktreeState {
  repo: string;
  path: string;
  branch: string;
  taskName: string;
  startedAt: string;
}

function statePath(agentDir: string): string {
  return join(agentDir, '.claude', 'state', 'active-task-worktree.json');
}

/**
 * Fixed, repo-derived root — only the final path segment (taskName) is
 * agent-supplied, and it must already have passed the letters/numbers/
 * hyphen/underscore check in startTaskWorktree before reaching here; this
 * function does not re-validate it. `resolvedRepo` must already be
 * canonicalized (see startTaskWorktree) so this basename matches the one
 * `validateTaskWorktreeRecord` re-derives on every read.
 */
function worktreeRootFor(resolvedRepo: string, taskName: string): string {
  return join(dirname(resolvedRepo), '.cortextos-task-worktrees', basename(resolvedRepo), taskName);
}

export function startTaskWorktree(
  agentDir: string,
  repo: string,
  taskName: string,
  branch?: string,
): { path: string; branch: string } {
  // Canonicalized so basename(resolvedRepo) matches what
  // validateTaskWorktreeRecord re-derives from record.repo on every read —
  // otherwise a repo reached through a differently-named symlink would
  // create a worktree path the hook can never recognize as valid.
  const resolvedRepo = canonicalizePath(resolve(repo));
  if (!existsSync(join(resolvedRepo, '.git'))) {
    throw new Error(`Not a git repository: ${resolvedRepo}`);
  }
  const sp = statePath(agentDir);
  if (existsSync(sp)) {
    throw new Error('A task worktree is already active for this agent. Run `task-worktree finish` first.');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(taskName)) {
    throw new Error('Task name must contain only letters, numbers, hyphens, and underscores.');
  }
  const branchName = branch || `task/${taskName}`;
  if (branchName === 'main' || branchName === 'master') {
    throw new Error('Refusing to use main/master as the task branch.');
  }
  const worktreeRoot = worktreeRootFor(resolvedRepo, taskName);
  if (existsSync(worktreeRoot)) {
    throw new Error(`Worktree path already exists: ${worktreeRoot}. Choose a different task name.`);
  }

  ensureDir(dirname(worktreeRoot));
  execFileSync('git', ['worktree', 'add', worktreeRoot, '-b', branchName], {
    cwd: resolvedRepo,
    stdio: 'pipe',
  });

  ensureDir(dirname(sp));
  const state: TaskWorktreeState = {
    repo: resolvedRepo,
    path: worktreeRoot,
    branch: branchName,
    taskName,
    startedAt: new Date().toISOString(),
  };
  atomicWriteSync(sp, JSON.stringify(state, null, 2));
  return { path: worktreeRoot, branch: branchName };
}

export async function finishTaskWorktree(
  agentDir: string,
  paths: BusPaths,
  agentName: string,
  org: string,
  action: 'merge' | 'abandon',
  frameworkRoot?: string,
): Promise<{ approvalId?: string; diffStat: string; commits: number; worktreeRemoved: boolean; branchDeleted?: boolean }> {
  const sp = statePath(agentDir);
  if (!existsSync(sp)) {
    throw new Error('No active task worktree for this agent.');
  }
  const rawState = JSON.parse(readFileSync(sp, 'utf-8'));

  // Close the trust window FIRST, before validating the record, computing
  // diffs, or touching the worktree. Once this file is gone, Bash calls in
  // this agent's session go back through the normal Telegram gate — so
  // nothing that happens after this line (including a later `git merge`,
  // performed as its own separately-approved step) can ride on the task's
  // elevated trust. `force: true` only suppresses ENOENT (already-missing
  // file); any other failure (e.g. EACCES) means the trust window is NOT
  // actually closed, which is a security-relevant condition, not routine
  // cleanup noise — surface it as such rather than letting a generic error
  // through.
  try {
    rmSync(sp, { force: true });
  } catch (err: any) {
    throw new Error(
      `Failed to revoke task-worktree trust — state file still present at ${sp}: ${err.message || err}`,
    );
  }

  // Re-validate the record before trusting ANY of its fields for the
  // destructive git operations below. This is the same check the hook
  // applies on every tool call — without it, a hand-crafted record (see
  // module doc above) would let `finish` run `git branch -D`/`git worktree
  // remove` against an arbitrary repo/branch the hook itself would never
  // have trusted. Trust has already been revoked (state file is gone by
  // this point), so refusing here costs nothing but a clear error.
  const validated = validateTaskWorktreeRecord(rawState);
  if (!validated) {
    throw new Error(
      'Task worktree record failed validation — refusing to run any git operations against it. ' +
      'The state file has been removed; if a worktree or branch still exists on disk, it must be cleaned up manually.',
    );
  }
  const state: TaskWorktreeState = { ...validated, startedAt: rawState.startedAt };

  let diffStat = '(diff summary unavailable)';
  let commits = 0;
  try {
    // Whatever the primary checkout currently has checked out, NOT
    // necessarily the repo's configured default branch — assumes nothing
    // else has the primary checkout mid-switch to a different branch while
    // finish() runs. Good enough for an approval-summary diff stat; not a
    // guarantee.
    const defaultBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: state.repo, encoding: 'utf-8',
    }).trim();
    try {
      commits = parseInt(
        execFileSync('git', ['rev-list', `${defaultBranch}..${state.branch}`, '--count'], {
          cwd: state.repo, encoding: 'utf-8',
        }).trim(), 10) || 0;
    } catch (err: any) {
      console.error(`task-worktree finish: failed to count commits: ${err.message || err}`);
    }
    try {
      const stat = execFileSync('git', ['diff', `${defaultBranch}...${state.branch}`, '--stat'], {
        cwd: state.repo, encoding: 'utf-8',
      });
      diffStat = stat.trim().split('\n').slice(-1)[0] || '(no changes)';
    } catch (err: any) {
      console.error(`task-worktree finish: failed to compute diff stat: ${err.message || err}`);
    }
  } catch (err: any) {
    // Couldn't even resolve the base branch (e.g. detached HEAD on the
    // primary checkout) — commits/diffStat stay at their "unavailable"
    // defaults rather than the misleading "0 commits, no diff" they'd
    // otherwise silently present to the merge approver.
    console.error(`task-worktree finish: failed to resolve base branch: ${err.message || err}`);
  }

  let worktreeRemoved = true;
  try {
    execFileSync('git', ['worktree', 'remove', state.path, '--force'], { cwd: state.repo, stdio: 'pipe' });
  } catch (err: any) {
    worktreeRemoved = false;
    console.error(
      `task-worktree finish: failed to remove worktree at ${state.path}: ${err.stderr?.toString?.() || err.message || err}`,
    );
  }

  if (action === 'abandon') {
    let branchDeleted = true;
    try {
      execFileSync('git', ['branch', '-D', state.branch], { cwd: state.repo, stdio: 'pipe' });
    } catch (err: any) {
      branchDeleted = false;
      console.error(
        `task-worktree finish: failed to delete branch ${state.branch}: ${err.stderr?.toString?.() || err.message || err}`,
      );
    }
    return { diffStat, commits, worktreeRemoved, branchDeleted };
  }

  const cleanupNote = worktreeRemoved
    ? ''
    : ` WARNING: the worktree checkout at ${state.path} could not be removed automatically and may still exist on disk.`;
  const approvalId = await createApproval(
    paths,
    agentName,
    org,
    `Merge task "${state.taskName}" (${state.branch})`,
    'deployment',
    `${commits} commit(s), ${diffStat}. Branch: ${state.branch} in ${state.repo}.${cleanupNote}`,
    frameworkRoot,
    agentDir,
  );
  return { approvalId, diffStat, commits, worktreeRemoved };
}
