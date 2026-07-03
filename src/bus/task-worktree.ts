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
import { join, dirname, resolve } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { createApproval } from './approval.js';
import {
  validateTaskWorktreeRecord,
  canonicalizePath,
  worktreeRootFor,
  isValidTaskName,
  isProtectedBranch,
  isGitRepoRoot,
  type ActiveTaskWorktree,
} from '../hooks/index.js';
import type { BusPaths } from '../types/index.js';

type TaskWorktreeState = ActiveTaskWorktree;

function statePath(agentDir: string): string {
  return join(agentDir, '.claude', 'state', 'active-task-worktree.json');
}

/**
 * Strip Telegram-Markdown-significant characters before interpolating a
 * value into the human-facing approval message. Backtick-wrapping alone is
 * NOT sufficient: an embedded backtick breaks out of the code span, and
 * link syntax (`[text](url)`) is applied by a later regex pass that isn't
 * aware of any code-span wrapping already applied — src/telegram/api.ts's
 * markdownToHtml runs its Markdown->HTML substitutions as sequential
 * string-wide passes, not tag-aware parsing, so a wrapped `[text](url)`
 * still renders as a live link. Stripping the characters that carry any
 * Markdown meaning here is more robust than trying to escape them.
 */
function sanitizeForApprovalText(value: string): string {
  return value.replace(/[`[\]()*_]/g, '');
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
  if (!isGitRepoRoot(resolvedRepo)) {
    throw new Error(`Not a git repository: ${resolvedRepo}`);
  }
  const sp = statePath(agentDir);
  if (existsSync(sp)) {
    throw new Error('A task worktree is already active for this agent. Run `task-worktree finish` first.');
  }
  if (!isValidTaskName(taskName)) {
    throw new Error('Task name must contain only letters, numbers, hyphens, and underscores.');
  }
  const branchName = branch || `task/${taskName}`;
  if (isProtectedBranch(branchName)) {
    throw new Error('Refusing to use main/master as the task branch.');
  }
  const worktreeRoot = worktreeRootFor(resolvedRepo, taskName);
  if (existsSync(worktreeRoot)) {
    throw new Error(`Worktree path already exists: ${worktreeRoot}. Choose a different task name.`);
  }

  // Checked BEFORE attempting `git worktree add`, not by pattern-matching
  // its stderr afterward. An earlier version distinguished "branch already
  // exists" from "destination already exists" by matching git's English
  // error text — under a non-English locale (verified empirically with
  // LANG=fr_FR.UTF-8) that regex never matches, so a genuinely pre-existing
  // branch fell through to the "git must have created this, roll it back"
  // path and got force-deleted. Checking existence up front removes the
  // locale dependency entirely: if the branch is already here, nothing
  // below ever needs to guess why `worktree add` failed.
  //
  // Fail CLOSED on an ambiguous result. `git rev-parse --verify --quiet`
  // exits 1 (and ONLY 1) to mean "this ref genuinely does not exist" — that
  // is the sole result we may safely read as "absent." Any other failure
  // (exit 128 on a corrupt/unreadable ref, ENOENT if git is missing, or a
  // thrown timeout/spawn error with no numeric status) means the check
  // could not determine existence. Treating those as "absent" would be the
  // same over-broad-signal bug this whole block exists to kill, one layer
  // up: a false "absent" skips the guard below, `git worktree add` then
  // fails because the branch really does exist, and the rollback path force-
  // deletes it. So on anything other than exit 1 we refuse to proceed rather
  // than march toward a destructive delete on a branch we couldn't see.
  let branchAlreadyExisted: boolean;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: resolvedRepo, stdio: 'pipe', timeout: 10000,
    });
    branchAlreadyExisted = true;
  } catch (err: any) {
    if (err.status === 1) {
      branchAlreadyExisted = false;
    } else {
      throw new Error(
        `Could not determine whether branch "${branchName}" already exists in ${resolvedRepo} ` +
        `(git rev-parse failed: ${err.stderr?.toString?.() || err.message || err}). Refusing to create the ` +
        `worktree, because proceeding now could later force-delete a branch this check failed to see.`,
      );
    }
  }
  if (branchAlreadyExisted) {
    // The most common real cause: a previous task with this same name was
    // finished via 'merge' (which intentionally leaves the branch behind —
    // see finishTaskWorktree) or via an 'abandon' whose branch-delete step
    // itself failed.
    throw new Error(
      `Failed to create worktree — branch "${branchName}" already exists (likely left over from a ` +
      `previous task with the same name that was merged, or whose cleanup failed). Delete it manually ` +
      `with \`git branch -D ${branchName}\` (in ${resolvedRepo}) or choose a different task name/branch.`,
    );
  }

  ensureDir(dirname(worktreeRoot));
  try {
    execFileSync('git', ['worktree', 'add', worktreeRoot, '-b', branchName], {
      cwd: resolvedRepo,
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() || err.message || String(err);
    // We already confirmed above that `branchName` did not exist before
    // this call, so any failure here (e.g. the destination directory
    // already existing and being non-empty) that leaves the branch present
    // is unambiguously an orphan git created as a side effect before
    // validating the destination — verified empirically, this isn't
    // speculative. No stderr text matching needed to know it's safe to
    // delete: existence alone is proof, since it couldn't have existed
    // beforehand.
    let branchNowExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: resolvedRepo, stdio: 'pipe', timeout: 10000,
      });
      branchNowExists = true;
    } catch (e: any) {
      // Exit 1 means the branch doesn't exist — expected and silent (git
      // never got far enough to create it). Anything else is an unexpected
      // failure of the check itself and is logged, matching this file's
      // fail-loud philosophy elsewhere.
      if (e.status !== 1) {
        console.error(`startTaskWorktree: rollback check for ${branchName} failed unexpectedly: ${e.stderr?.toString?.() || e.message}`);
      }
    }
    let rollbackErr: any = null;
    if (branchNowExists) {
      try {
        execFileSync('git', ['branch', '-D', branchName], { cwd: resolvedRepo, stdio: 'pipe', timeout: 10000 });
      } catch (e: any) {
        rollbackErr = e;
        console.error(`startTaskWorktree: failed to roll back orphaned branch ${branchName}: ${e.stderr?.toString?.() || e.message}`);
      }
    }
    throw new Error(
      `Failed to create worktree at ${worktreeRoot}: ${stderr}` +
      (rollbackErr ? ` Additionally, orphaned branch "${branchName}" could not be cleaned up automatically — delete it manually with \`git branch -D ${branchName}\` (in ${resolvedRepo}).` : ''),
    );
  }

  // The worktree/branch now exist on disk with no state file yet — if
  // anything below fails, roll the worktree back rather than leaving an
  // orphaned, untracked worktree that getActiveTaskWorktree has no way to
  // discover (it only ever looks for a state file, never scans disk).
  try {
    ensureDir(dirname(sp));
    const state: TaskWorktreeState = {
      repo: resolvedRepo,
      path: worktreeRoot,
      branch: branchName,
      taskName,
      startedAt: new Date().toISOString(),
    };
    atomicWriteSync(sp, JSON.stringify(state, null, 2));
  } catch (err: any) {
    // Independent try/catches — reporting which of the two actually failed
    // matters. A combined try/catch would blame both the worktree AND the
    // branch for manual cleanup even when only one of them survived,
    // sending the operator chasing a "worktree remove" on a path that's
    // already gone.
    let removeErr: any = null;
    let branchErr: any = null;
    try {
      execFileSync('git', ['worktree', 'remove', worktreeRoot, '--force'], { cwd: resolvedRepo, stdio: 'pipe', timeout: 10000 });
    } catch (e: any) {
      removeErr = e;
    }
    try {
      execFileSync('git', ['branch', '-D', branchName], { cwd: resolvedRepo, stdio: 'pipe', timeout: 10000 });
    } catch (e: any) {
      branchErr = e;
    }
    if (removeErr || branchErr) {
      throw new Error(
        `Failed to record task worktree state (${err.message || err}). Rollback incomplete: ` +
        (removeErr ? `worktree still exists at ${worktreeRoot} (${removeErr.message || removeErr}); ` : 'worktree removed; ') +
        (branchErr ? `branch ${branchName} still exists (${branchErr.message || branchErr}).` : 'branch deleted.') +
        ' Clean up manually whatever remains.',
      );
    }
    throw new Error(`Failed to record task worktree state: ${err.message || err}`);
  }
  return { path: worktreeRoot, branch: branchName };
}

export async function finishTaskWorktree(
  agentDir: string,
  paths: BusPaths,
  agentName: string,
  org: string,
  action: 'merge' | 'abandon',
  frameworkRoot?: string,
): Promise<{ approvalId?: string; diffStat: string; commits: number | null; worktreeRemoved: boolean; branchDeleted?: boolean }> {
  const sp = statePath(agentDir);
  if (!existsSync(sp)) {
    throw new Error('No active task worktree for this agent.');
  }

  // Read+parse BEFORE revoking trust — the record's fields (repo/branch/
  // path) are needed for the git operations below, and once the state file
  // is gone (next block) that data is unrecoverable. But if the read/parse
  // itself fails (corrupted/truncated JSON, a TOCTOU race where the file
  // vanished between the existsSync above and here), still attempt to
  // revoke trust before throwing — otherwise a corrupted state file would
  // leave the trust window open forever AND permanently strand the agent,
  // since `start` refuses while this file exists and `finish` would hit
  // this same unhandled error on every future attempt.
  let rawState: any;
  try {
    rawState = JSON.parse(readFileSync(sp, 'utf-8'));
  } catch (err: any) {
    // Track whether removal actually succeeded — the thrown message must
    // not claim the trust window is closed if it isn't. Getting this wrong
    // would silently reintroduce the exact stranding bug this whole branch
    // exists to fix, just with a misleading "already cleaned up" message
    // on top of it.
    let removed = false;
    try {
      rmSync(sp, { force: true });
      removed = true;
    } catch (rmErr: any) {
      console.error(`task-worktree finish: failed to remove corrupted state file ${sp}: ${rmErr.message || rmErr}`);
    }
    throw new Error(
      `Active task-worktree state file was corrupted and could not be read/parsed: ${sp}: ${err.message || err}. ` +
      (removed
        ? 'The file has been removed so a new task can be started; if a worktree or branch still exists on disk, it must be cleaned up manually.'
        : 'The corrupted file could NOT be removed — the trust window is still open and no new task can be started until it is deleted manually (see stderr for the removal failure).'),
    );
  }

  // Close the trust window, before validating the record, computing diffs,
  // or touching the worktree. Once this file is gone, Bash calls in this
  // agent's session go back through the normal Telegram gate — so nothing
  // that happens after this line can ride on the task's elevated trust,
  // including the actual `git merge` (a manual follow-up performed by the
  // agent per the implement-review-loop skill's Step 5 — not run by this
  // function or anything else in this file). `force: true` only suppresses
  // ENOENT (already-missing file); any other failure (e.g. EACCES) means
  // the trust window is NOT actually closed, which is a security-relevant
  // condition, not routine cleanup noise — surface it as such rather than
  // letting a generic error through.
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
    // validateTaskWorktreeRecord already logged the specific reason (which
    // field, which mismatch, or the underlying git error) to stderr — the
    // thrown message here stays generic on purpose (no security benefit to
    // repeating specifics in an exception that might surface to Telegram),
    // but the reason is not actually lost, just logged separately.
    throw new Error(
      'Task worktree record failed validation — refusing to run any git operations against it. ' +
      'The state file has been removed; if a worktree or branch still exists on disk, it must be cleaned up manually. ' +
      'See stderr/logs for the specific validation failure.',
    );
  }
  // validated (an ActiveTaskWorktree) already includes a type-checked
  // startedAt — no separate pull from rawState or fallback default needed
  // now that validateTaskWorktreeRecord covers this field too.
  const state: TaskWorktreeState = validated;

  let diffStat = '(diff summary unavailable)';
  let commits: number | null = null;
  try {
    // Whatever `state.repo`'s own checkout currently has checked out, NOT
    // necessarily the repo's configured default branch (and if `state.repo`
    // is itself a worktree/submodule rather than the primary checkout, this
    // is THAT checkout's branch, not the primary one's) — assumes nothing
    // else switches it to a different branch while finish() runs. Good
    // enough for an approval-summary diff stat; not a guarantee.
    const baseBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: state.repo, encoding: 'utf-8', timeout: 10000,
    }).trim();
    try {
      const parsed = parseInt(
        execFileSync('git', ['rev-list', `${baseBranch}..${state.branch}`, '--count'], {
          cwd: state.repo, encoding: 'utf-8', timeout: 10000,
        }).trim(), 10);
      // Number.isNaN, not `|| 0` — a NaN here means git emitted something
      // unexpected, not "zero commits." Falling back to 0 would reintroduce
      // the exact fabricated-count problem this function otherwise avoids.
      commits = Number.isNaN(parsed) ? null : parsed;
    } catch (err: any) {
      console.error(`task-worktree finish: failed to count commits: ${err.message || err}`);
    }
    try {
      const stat = execFileSync('git', ['diff', `${baseBranch}...${state.branch}`, '--stat'], {
        cwd: state.repo, encoding: 'utf-8', timeout: 10000,
      });
      diffStat = stat.trim().split('\n').slice(-1)[0] || '(no changes)';
    } catch (err: any) {
      console.error(`task-worktree finish: failed to compute diff stat: ${err.message || err}`);
    }
  } catch (err: any) {
    // Couldn't even resolve the base branch (e.g. detached HEAD on
    // state.repo's own checkout — which, per the comment above, may itself
    // be a worktree/submodule rather than the primary checkout) —
    // commits/diffStat stay at their "unavailable" defaults rather than the
    // misleading "0 commits, no diff" they'd otherwise silently present to
    // the merge approver.
    console.error(`task-worktree finish: failed to resolve base branch: ${err.message || err}`);
  }

  let worktreeRemoved = true;
  try {
    execFileSync('git', ['worktree', 'remove', state.path, '--force'], { cwd: state.repo, stdio: 'pipe', timeout: 10000 });
  } catch (err: any) {
    worktreeRemoved = false;
    console.error(
      `task-worktree finish: failed to remove worktree at ${state.path}: ${err.stderr?.toString?.() || err.message || err}`,
    );
  }

  if (action === 'abandon') {
    let branchDeleted = true;
    try {
      execFileSync('git', ['branch', '-D', state.branch], { cwd: state.repo, stdio: 'pipe', timeout: 10000 });
    } catch (err: any) {
      branchDeleted = false;
      console.error(
        `task-worktree finish: failed to delete branch ${state.branch}: ${err.stderr?.toString?.() || err.message || err}`,
      );
    }
    return { diffStat, commits, worktreeRemoved, branchDeleted };
  }

  // Sanitized (not just backtick-wrapped, see sanitizeForApprovalText's doc
  // comment for why wrapping alone doesn't work) before interpolation —
  // taskName is charset-validated by validateTaskWorktreeRecord so this is
  // defense-in-depth for it, but branch/repo/path/diffStat have no such
  // restriction: diffStat in particular is git's own `diff --stat` summary
  // line, and while that line is git-generated rather than a raw filename
  // today, relying on that as a guarantee rather than just sanitizing it
  // like everything else in this message would be exactly the kind of
  // unstated format assumption this function otherwise avoids.
  const cleanupNote = worktreeRemoved
    ? ''
    : ` WARNING: the worktree checkout at ${sanitizeForApprovalText(state.path)} could not be removed automatically and may still exist on disk.`;
  const commitsText = commits === null ? 'commit count unavailable' : `${commits} commit(s)`;
  const safeTaskName = sanitizeForApprovalText(state.taskName);
  const safeBranch = sanitizeForApprovalText(state.branch);
  const approvalTitle = `Merge task "${safeTaskName}" (${safeBranch})`;
  const approvalContext = `${commitsText}, ${sanitizeForApprovalText(diffStat)}. Branch: ${safeBranch} in ${sanitizeForApprovalText(state.repo)}.${cleanupNote}`;

  try {
    const approvalId = await createApproval(
      paths,
      agentName,
      org,
      approvalTitle,
      'deployment',
      approvalContext,
      frameworkRoot,
      agentDir,
    );
    return { approvalId, diffStat, commits, worktreeRemoved };
  } catch (err: any) {
    // Trust is already revoked and the worktree cleanup already ran by this
    // point — losing THIS information on top of a failed approval would
    // leave no record anywhere of what happened to the worktree/branch.
    console.error(
      `task-worktree finish: failed to create merge approval (worktreeRemoved=${worktreeRemoved}, ` +
      `commits=${commits ?? 'unavailable'}, diffStat=${JSON.stringify(diffStat)}, branch=${state.branch}, ` +
      `repo=${state.repo}): ${err.message || err}`,
    );
    throw err;
  }
}
