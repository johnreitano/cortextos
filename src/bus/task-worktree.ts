/**
 * Task worktrees — an isolated, git-tracked sandbox an agent can work in
 * without triggering a Telegram approval round-trip on every tool call.
 *
 * The hook in src/hooks/index.ts (isTaskWorktreeOperation) trusts a task
 * worktree's own file tree for Edit/Write, and trusts Bash unconditionally
 * for the lifetime of the task (see that file's doc comment for why Bash
 * can't be scoped to the worktree the way Edit/Write can). This module is
 * the ONLY code path allowed to create the state file that grants that
 * trust — the agent itself never writes it directly, even though it lives
 * under the already-trusted `.claude/` tree, so an agent can't just point
 * the record at an arbitrary path to escalate its own trust.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { createApproval } from './approval.js';
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

/** Fixed, predictable location — never derived from agent-supplied free text. */
function worktreeRootFor(resolvedRepo: string, taskName: string): string {
  return join(dirname(resolvedRepo), '.cortextos-task-worktrees', basename(resolvedRepo), taskName);
}

export function startTaskWorktree(
  agentDir: string,
  repo: string,
  taskName: string,
  branch?: string,
): { path: string; branch: string } {
  const resolvedRepo = resolve(repo);
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
): Promise<{ approvalId?: string; diffStat: string; commits: number }> {
  const sp = statePath(agentDir);
  if (!existsSync(sp)) {
    throw new Error('No active task worktree for this agent.');
  }
  const state: TaskWorktreeState = JSON.parse(readFileSync(sp, 'utf-8'));

  // Close the trust window FIRST, before computing diffs, requesting
  // approval, or touching the worktree. Once this file is gone, Bash calls
  // in this agent's session go back through the normal Telegram gate — so
  // nothing that happens after this line (including a later `git merge`,
  // performed as its own separately-approved step) can ride on the task's
  // elevated trust.
  rmSync(sp, { force: true });

  let diffStat = '';
  let commits = 0;
  try {
    const defaultBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: state.repo, encoding: 'utf-8',
    }).trim();
    commits = parseInt(
      execFileSync('git', ['rev-list', `${defaultBranch}..${state.branch}`, '--count'], {
        cwd: state.repo, encoding: 'utf-8',
      }).trim(), 10) || 0;
    const stat = execFileSync('git', ['diff', `${defaultBranch}...${state.branch}`, '--stat'], {
      cwd: state.repo, encoding: 'utf-8',
    });
    diffStat = stat.trim().split('\n').slice(-1)[0] || '';
  } catch { /* best-effort — a bad diff summary shouldn't block cleanup */ }

  try {
    execFileSync('git', ['worktree', 'remove', state.path, '--force'], { cwd: state.repo, stdio: 'pipe' });
  } catch { /* worktree may already be gone (e.g. crashed mid-task) — not fatal */ }

  if (action === 'abandon') {
    try {
      execFileSync('git', ['branch', '-D', state.branch], { cwd: state.repo, stdio: 'pipe' });
    } catch { /* ignore */ }
    return { diffStat, commits };
  }

  const approvalId = await createApproval(
    paths,
    agentName,
    org,
    `Merge task "${state.taskName}" (${state.branch})`,
    'deployment',
    `${commits} commit(s), ${diffStat || 'no diff stat available'}. Branch: ${state.branch} in ${state.repo}.`,
    frameworkRoot,
    agentDir,
  );
  return { approvalId, diffStat, commits };
}
