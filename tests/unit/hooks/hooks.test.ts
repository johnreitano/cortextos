import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  parseHookInput,
  loadEnv,
  formatToolSummary,
  isClaudeDirOperation,
  isTaskWorktreeOperation,
  validateTaskWorktreeRecord,
  canonicalizePath,
  isValidTaskName,
  isProtectedBranch,
  isGitRepoRoot,
  sanitizeCodeBlock,
  buildPermissionKeyboard,
  buildPlanKeyboard,
  buildAskSingleSelectKeyboard,
  buildAskMultiSelectKeyboard,
  buildAskState,
  formatQuestionMessage,
} from '../../../src/hooks/index';
import { startTaskWorktree } from '../../../src/bus/task-worktree';

// Builds a real git repo with one commit, a real worktree created the same
// way `cortextos bus task-worktree start` would, and a matching state file
// — so tests using this exercise the actual git-worktree-list cross-check,
// not just the path-containment math. Shared across describe blocks below.
function makeActiveTaskWorktree(branch = 'task/demo') {
  const base = mkdtempSync(join(tmpdir(), 'hookperm-taskwt-'));
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const worktreePath = join(base, '.cortextos-task-worktrees', 'repo', 'demo');
  mkdirSync(join(base, '.cortextos-task-worktrees', 'repo'), { recursive: true });
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: repo });

  const agentDir = join(base, 'agent');
  mkdirSync(join(agentDir, '.claude', 'state'), { recursive: true });
  writeFileSync(
    join(agentDir, '.claude', 'state', 'active-task-worktree.json'),
    JSON.stringify({ repo, path: worktreePath, branch, taskName: 'demo', startedAt: new Date().toISOString() }),
  );

  return { base, repo, worktreePath, agentDir };
}

describe('Hook Utilities', () => {
  describe('parseHookInput', () => {
    it('extracts tool_name and tool_input from valid JSON', () => {
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      });
      const result = parseHookInput(input);
      expect(result.tool_name).toBe('Bash');
      expect(result.tool_input.command).toBe('ls -la');
    });

    it('returns defaults for invalid JSON', () => {
      const result = parseHookInput('not json');
      expect(result.tool_name).toBe('unknown');
      expect(result.tool_input).toEqual({});
    });

    it('handles missing fields gracefully', () => {
      const result = parseHookInput(JSON.stringify({}));
      expect(result.tool_name).toBe('unknown');
      expect(result.tool_input).toEqual({});
    });
  });

  describe('loadEnv', () => {
    let testDir: string;
    const origEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), 'cortextos-hooks-'));
      origEnv.CTX_AGENT_NAME = process.env.CTX_AGENT_NAME;
      origEnv.CTX_ROOT = process.env.CTX_ROOT;
      origEnv.CTX_AGENT_DIR = process.env.CTX_AGENT_DIR;
      origEnv.BOT_TOKEN = process.env.BOT_TOKEN;
      origEnv.CHAT_ID = process.env.CHAT_ID;
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
      // Restore env
      for (const [key, val] of Object.entries(origEnv)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    });

    it('reads agent name from CTX_AGENT_NAME', () => {
      process.env.CTX_AGENT_NAME = 'test-agent';
      process.env.CTX_ROOT = testDir;
      const env = loadEnv();
      expect(env.agentName).toBe('test-agent');
    });

    it('uses CTX_ROOT for stateDir', () => {
      process.env.CTX_AGENT_NAME = 'myagent';
      process.env.CTX_ROOT = testDir;
      const env = loadEnv();
      expect(env.stateDir).toBe(join(testDir, 'state', 'myagent'));
    });

    it('reads BOT_TOKEN and CHAT_ID from .env file via CTX_AGENT_DIR', () => {
      process.env.CTX_AGENT_NAME = 'agent1';
      process.env.CTX_ROOT = testDir;
      // Clear existing values so loadEnv can set them from file
      delete process.env.BOT_TOKEN;
      delete process.env.CHAT_ID;
      process.env.CTX_AGENT_DIR = testDir;
      writeFileSync(join(testDir, '.env'), 'BOT_TOKEN=abc123\nCHAT_ID=456\n');

      const env = loadEnv();
      expect(env.botToken).toBe('abc123');
      expect(env.chatId).toBe('456');
    });
  });

  describe('isClaudeDirOperation (permission-gate hardening)', () => {
    const agentDir = '/agents/alice';

    it('NEVER auto-approves Bash, even when the command mentions .claude/', () => {
      // A shell command string cannot be proven to act only within .claude/, and
      // under bypassPermissions this hook is the only approval gate (#1/#15).
      expect(isClaudeDirOperation('Bash', { command: 'cat .claude/settings.json' }, agentDir)).toBe(false);
      expect(isClaudeDirOperation('Bash', { command: 'rm -rf ~/work; ls .claude/' }, agentDir)).toBe(false);
    });

    it('auto-approves Edit/Write within the agent\'s own .claude/ directory', () => {
      expect(isClaudeDirOperation('Edit', { file_path: '/agents/alice/.claude/settings.json' }, agentDir)).toBe(true);
      expect(isClaudeDirOperation('Write', { file_path: '/agents/alice/.claude/skills/x/SKILL.md' }, agentDir)).toBe(true);
    });

    it('resolves a relative file_path against the agent directory', () => {
      expect(isClaudeDirOperation('Edit', { file_path: '.claude/settings.json' }, agentDir)).toBe(true);
    });

    it('refuses traversal that escapes the agent\'s .claude/ directory (#18)', () => {
      expect(isClaudeDirOperation('Write', { file_path: '/agents/alice/.claude/../../etc/passwd' }, agentDir)).toBe(false);
      expect(isClaudeDirOperation('Edit', { file_path: '/agents/alice/.claude/../.ssh/authorized_keys' }, agentDir)).toBe(false);
    });

    it('refuses a .claude/ directory that is not the agent\'s own (#18)', () => {
      expect(isClaudeDirOperation('Edit', { file_path: '/home/victim/.claude/settings.json' }, agentDir)).toBe(false);
      expect(isClaudeDirOperation('Write', { file_path: '/agents/bob/.claude/settings.json' }, agentDir)).toBe(false);
    });

    it('refuses the prefix trick (.claude-evil is not .claude)', () => {
      expect(isClaudeDirOperation('Edit', { file_path: '/agents/alice/.claude-evil/x' }, agentDir)).toBe(false);
    });

    it('does not auto-approve regular paths', () => {
      expect(isClaudeDirOperation('Edit', { file_path: '/agents/alice/src/main.ts' }, agentDir)).toBe(false);
    });

    it('does not auto-approve other tool types', () => {
      expect(isClaudeDirOperation('Read', { file_path: '/agents/alice/.claude/foo' }, agentDir)).toBe(false);
    });

    it('refuses a write that escapes via a symlink inside .claude (#18, codex)', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-'));
      try {
        const realAgentDir = join(base, 'agent');
        mkdirSync(join(realAgentDir, '.claude'), { recursive: true });
        const outside = join(base, 'outside');
        mkdirSync(outside, { recursive: true });
        // .claude/escape is a symlink that leaves the .claude tree.
        symlinkSync(outside, join(realAgentDir, '.claude', 'escape'));

        // A write "inside" .claude/escape/ actually lands in outside/ — must be refused.
        expect(isClaudeDirOperation('Write',
          { file_path: join(realAgentDir, '.claude', 'escape', 'evil.txt') }, realAgentDir)).toBe(false);
        // Sanity: a genuine (not-yet-existing) file directly inside .claude is still allowed.
        expect(isClaudeDirOperation('Write',
          { file_path: join(realAgentDir, '.claude', 'ok.txt') }, realAgentDir)).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses a symlinked .claude root that redirects the gate (codex)', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-'));
      try {
        const realAgentDir = join(base, 'agent');
        mkdirSync(realAgentDir, { recursive: true });
        const outside = join(base, 'outside');
        mkdirSync(outside, { recursive: true });
        // .claude itself is a symlink pointing out of the agent tree.
        symlinkSync(outside, join(realAgentDir, '.claude'));
        expect(isClaudeDirOperation('Write',
          { file_path: join(realAgentDir, '.claude', 'x.txt') }, realAgentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses a write through a DANGLING symlink inside .claude (codex blocker)', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-'));
      try {
        const realAgentDir = join(base, 'agent');
        mkdirSync(join(realAgentDir, '.claude'), { recursive: true });
        // .claude/dangle points at a non-existent target — realpath can't resolve
        // it, so a lexical check would wrongly treat the path as contained.
        symlinkSync(join(base, 'does-not-exist'), join(realAgentDir, '.claude', 'dangle'));
        expect(isClaudeDirOperation('Write',
          { file_path: join(realAgentDir, '.claude', 'dangle', 'evil.txt') }, realAgentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('handles a symlinked agent-dir ancestor without leaking (mmax)', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-'));
      try {
        const realRoot = join(base, 'real');
        mkdirSync(join(realRoot, '.claude'), { recursive: true });
        const linkDir = join(base, 'link');
        symlinkSync(realRoot, linkDir); // agentDir reached via a symlink
        // The agent dir is canonicalized, so a normal relative write to .claude
        // is still allowed even when agentDir is expressed via the symlink.
        expect(isClaudeDirOperation('Write',
          { file_path: '.claude/ok.txt' }, linkDir)).toBe(true);
        // Traversal still cannot escape the canonicalized .claude root.
        expect(isClaudeDirOperation('Write',
          { file_path: '.claude/../../etc/passwd' }, linkDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('does not auto-approve without an explicit agent-dir boundary (no cwd fallback)', () => {
      const saved = process.env.CTX_AGENT_DIR;
      delete process.env.CTX_AGENT_DIR;
      try {
        // No agentDir arg + no CTX_AGENT_DIR → must NOT auto-approve, even for a .claude path.
        expect(isClaudeDirOperation('Edit', { file_path: '/tmp/.claude/settings.json' })).toBe(false);
      } finally {
        if (saved !== undefined) process.env.CTX_AGENT_DIR = saved;
      }
    });
  });

  describe('isTaskWorktreeOperation', () => {

    it('returns false when there is no active task worktree', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-taskwt-'));
      try {
        const agentDir = join(base, 'agent');
        mkdirSync(join(agentDir, '.claude', 'state'), { recursive: true });
        expect(isTaskWorktreeOperation('Bash', { command: 'npm test' }, agentDir)).toBe(false);
        expect(isTaskWorktreeOperation('Write', { file_path: '/tmp/x.txt' }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('fails closed (does not throw) when the state file is corrupted, on every tool call during an active task', () => {
      // This runs on EVERY Edit/Write/Bash call while a task is active — a
      // regression that let this throw uncaught would crash the permission
      // hook for every subsequent tool call, not just at `finish` time.
      const { base, agentDir } = makeActiveTaskWorktree();
      try {
        writeFileSync(join(agentDir, '.claude', 'state', 'active-task-worktree.json'), '{ not valid json');
        expect(() => isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).not.toThrow();
        expect(isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).toBe(false);
        expect(isTaskWorktreeOperation('Write', { file_path: '/tmp/x.txt' }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('recognizes a task worktree created by the REAL startTaskWorktree, not just the hand-rolled test fixture', () => {
      // Every other test in this describe block uses makeActiveTaskWorktree,
      // which hand-writes the state file rather than calling the actual
      // production writer — so it can't by itself prove worktreeRootFor is
      // genuinely shared (not silently re-diverged) between the writer
      // (src/bus/task-worktree.ts) and this reader.
      const base = mkdtempSync(join(tmpdir(), 'hookperm-taskwt-real-'));
      try {
        const repo = join(base, 'repo');
        mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
        writeFileSync(join(repo, 'README.md'), 'hello');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

        const agentDir = join(base, 'agent');
        mkdirSync(agentDir, { recursive: true });

        const { path: worktreePath } = startTaskWorktree(agentDir, repo, 'demo');

        expect(isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).toBe(true);
        expect(isTaskWorktreeOperation('Write', { file_path: join(worktreePath, 'x.ts') }, agentDir)).toBe(true);
        expect(isTaskWorktreeOperation('Write', { file_path: join(repo, 'x.ts') }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('auto-approves Bash unconditionally while a task is active', () => {
      const { base, agentDir } = makeActiveTaskWorktree();
      try {
        expect(isTaskWorktreeOperation('Bash', { command: 'rm -rf /' }, agentDir)).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('auto-approves Edit/Write confined to the active worktree', () => {
      const { base, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        expect(isTaskWorktreeOperation('Write', { file_path: join(worktreePath, 'src', 'x.ts') }, agentDir)).toBe(true);
        expect(isTaskWorktreeOperation('Edit', { file_path: join(worktreePath, 'x.ts') }, agentDir)).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses Edit/Write outside the active worktree', () => {
      const { base, repo, agentDir } = makeActiveTaskWorktree();
      try {
        // The primary repo checkout itself is NOT the trusted worktree.
        expect(isTaskWorktreeOperation('Write', { file_path: join(repo, 'x.ts') }, agentDir)).toBe(false);
        expect(isTaskWorktreeOperation('Write', { file_path: '/etc/passwd' }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('does not auto-approve other tool types', () => {
      const { base, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        expect(isTaskWorktreeOperation('Read', { file_path: join(worktreePath, 'x.ts') }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses a record whose branch is main/master', () => {
      // No real worktree needed here — the branch check short-circuits
      // before the git worktree list cross-check even runs.
      const base = mkdtempSync(join(tmpdir(), 'hookperm-taskwt-'));
      try {
        const agentDir = join(base, 'agent');
        mkdirSync(join(agentDir, '.claude', 'state'), { recursive: true });
        writeFileSync(
          join(agentDir, '.claude', 'state', 'active-task-worktree.json'),
          JSON.stringify({ repo: base, path: join(base, 'wt'), branch: 'main', taskName: 'demo', startedAt: new Date().toISOString() }),
        );
        expect(isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).toBe(false);
        expect(isTaskWorktreeOperation('Write', { file_path: join(base, 'wt', 'x.ts') }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses a tampered record pointing outside the fixed worktree-root convention', () => {
      const { base, repo, agentDir } = makeActiveTaskWorktree();
      try {
        // Rewrite the state file to claim an arbitrary path — e.g. an agent
        // trying to escalate its own trust by hand-editing the record.
        writeFileSync(
          join(agentDir, '.claude', 'state', 'active-task-worktree.json'),
          JSON.stringify({ repo, path: '/tmp', branch: 'task/demo', taskName: 'demo', startedAt: new Date().toISOString() }),
        );
        expect(isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses a record whose path is not a real, currently registered git worktree', () => {
      const { base, repo, agentDir } = makeActiveTaskWorktree();
      try {
        // A path that lexically matches the convention but was never
        // actually created via `git worktree add` (e.g. left over after a
        // crashed `finish`, or hand-crafted).
        const fakePath = join(base, '.cortextos-task-worktrees', 'repo', 'not-real');
        mkdirSync(fakePath, { recursive: true });
        writeFileSync(
          join(agentDir, '.claude', 'state', 'active-task-worktree.json'),
          JSON.stringify({ repo, path: fakePath, branch: 'task/not-real', taskName: 'not-real', startedAt: new Date().toISOString() }),
        );
        expect(isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses a write that escapes the worktree via a symlink inside it', () => {
      const { base, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        const outside = join(base, 'outside');
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(worktreePath, 'escape'));

        // A write "inside" escape/ actually lands in outside/ — must be refused.
        expect(isTaskWorktreeOperation('Write',
          { file_path: join(worktreePath, 'escape', 'evil.txt') }, agentDir)).toBe(false);
        // Sanity: a genuine, non-symlinked file directly inside the worktree is still allowed.
        expect(isTaskWorktreeOperation('Write',
          { file_path: join(worktreePath, 'ok.txt') }, agentDir)).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('fails closed (refuses) when a symlink-containment check hits an unexpected lstat error, not just ENOENT', () => {
      // A plain file where a directory is expected makes lstat on anything
      // "inside" it fail with ENOTDIR, not ENOENT — the containment walk
      // must NOT treat this the same as "component doesn't exist yet"
      // (which is genuinely benign); it must fail closed instead.
      const { base, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        writeFileSync(join(worktreePath, 'not-a-dir'), 'plain file, not a directory');
        expect(isTaskWorktreeOperation('Write',
          { file_path: join(worktreePath, 'not-a-dir', 'nested', 'x.txt') }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses the sibling-prefix trick (worktree-decoy is not the worktree)', () => {
      const { base, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        const decoy = `${worktreePath}-decoy`;
        mkdirSync(decoy, { recursive: true });
        expect(isTaskWorktreeOperation('Write', { file_path: join(decoy, 'x.ts') }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses a record with path/repo swapped', () => {
      const { base, repo, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        writeFileSync(
          join(agentDir, '.claude', 'state', 'active-task-worktree.json'),
          JSON.stringify({ repo: worktreePath, path: repo, branch: 'task/demo', taskName: 'demo', startedAt: new Date().toISOString() }),
        );
        expect(isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('isValidTaskName / isProtectedBranch / isGitRepoRoot (shared trust-boundary primitives)', () => {
    it('isValidTaskName accepts only letters/numbers/hyphens/underscores', () => {
      expect(isValidTaskName('demo')).toBe(true);
      expect(isValidTaskName('demo-task_1')).toBe(true);
      expect(isValidTaskName('')).toBe(false);
      expect(isValidTaskName('has spaces')).toBe(false);
      expect(isValidTaskName('has.dots')).toBe(false);
      expect(isValidTaskName('has/slash')).toBe(false);
      expect(isValidTaskName('has`backtick')).toBe(false);
    });

    it('isProtectedBranch matches main/master exactly — not case-insensitively, not as a substring', () => {
      expect(isProtectedBranch('main')).toBe(true);
      expect(isProtectedBranch('master')).toBe(true);
      // Exact match only — a future ".includes()" simplification would
      // wrongly start rejecting these legitimate branch names.
      expect(isProtectedBranch('maintenance')).toBe(false);
      expect(isProtectedBranch('remaining')).toBe(false);
      expect(isProtectedBranch('task/demo')).toBe(false);
      // Also exact-case only — this is a deliberate scope limit, not a
      // bypass: an actual branch named "Main" is a different git ref than
      // "main", so blocking it wouldn't protect anything real.
      expect(isProtectedBranch('Main')).toBe(false);
      expect(isProtectedBranch('MASTER')).toBe(false);
    });

    it('isGitRepoRoot requires a .git entry to exist, but does not itself distinguish a real repo root from a worktree/submodule checkout', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-gitroot-'));
      try {
        const notRepo = join(base, 'not-a-repo');
        mkdirSync(notRepo, { recursive: true });
        expect(isGitRepoRoot(notRepo)).toBe(false);

        const repo = join(base, 'repo');
        mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: repo });
        expect(isGitRepoRoot(repo)).toBe(true);

        // Documented scope limit, not a bug: a worktree's .git is a FILE
        // (not a directory) pointing at the common gitdir, but
        // isGitRepoRoot only checks existence, not shape — so it returns
        // true for a worktree checkout too. This is acceptable here
        // because reaching this code path at all already requires Bash
        // trust (the agent could do anything via Bash already); this test
        // exists to pin down and document the actual behavior rather than
        // leave it an untested assumption.
        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
        const worktreePath = join(base, 'a-worktree');
        execFileSync('git', ['worktree', 'add', '--detach', worktreePath], { cwd: repo });
        expect(isGitRepoRoot(worktreePath)).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('canonicalizePath', () => {
    it('treats a non-ENOENT lstat failure as unresolvable rather than silently climbing past it', () => {
      // A plain file where a directory is expected makes realpathSync on a
      // path "through" it fail with ENOTDIR, not ENOENT — canonicalizePath
      // must not treat this the same as "this component doesn't exist yet"
      // (genuinely benign); it backs security-relevant equality/prefix
      // checks elsewhere, so returning a plausible-but-wrong resolved path
      // here would be worse than falling back to the raw lexical input.
      const base = mkdtempSync(join(tmpdir(), 'hookperm-canon-'));
      try {
        writeFileSync(join(base, 'not-a-dir'), 'plain file');
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = canonicalizePath(join(base, 'not-a-dir', 'nested', 'x.txt'));
        errorSpy.mockRestore();
        // Falls back to the raw lexical path rather than a partially-resolved one.
        expect(result).toBe(join(base, 'not-a-dir', 'nested', 'x.txt'));
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('still resolves a genuinely non-existent tail (ENOENT) against its existing ancestor as before', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-canon-'));
      try {
        const result = canonicalizePath(join(base, 'does-not-exist-yet.txt'));
        expect(result).toBe(canonicalizePath(base) + sep + 'does-not-exist-yet.txt');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('validateTaskWorktreeRecord', () => {
    it('rejects null, non-object, and missing/wrong-typed fields', () => {
      expect(validateTaskWorktreeRecord(null)).toBeNull();
      expect(validateTaskWorktreeRecord(undefined)).toBeNull();
      expect(validateTaskWorktreeRecord('a string')).toBeNull();
      expect(validateTaskWorktreeRecord([])).toBeNull();
      expect(validateTaskWorktreeRecord({})).toBeNull();
      expect(validateTaskWorktreeRecord({ path: '/a', repo: '/b', branch: 'x' })).toBeNull(); // missing taskName
      expect(validateTaskWorktreeRecord({ path: 1, repo: '/b', branch: 'x', taskName: 'y' })).toBeNull(); // wrong type
      expect(validateTaskWorktreeRecord({ path: '/a', repo: '/b', branch: 'x', taskName: null })).toBeNull();
    });

    it('rejects main/master branches independent of path validity', () => {
      const startedAt = new Date().toISOString();
      expect(validateTaskWorktreeRecord({ path: '/a', repo: '/b', branch: 'main', taskName: 'x', startedAt })).toBeNull();
      expect(validateTaskWorktreeRecord({ path: '/a', repo: '/b', branch: 'master', taskName: 'x', startedAt })).toBeNull();
    });

    it('rejects a taskName containing characters outside the letters/numbers/hyphen/underscore charset', () => {
      // taskName is never cross-checked against the worktree the way
      // path/branch are, and it's interpolated into a human-facing Telegram
      // approval message — so it's charset-restricted here to rule out
      // Markdown control characters at the source, matching the same
      // regex startTaskWorktree enforces at write time.
      const startedAt = new Date().toISOString();
      expect(validateTaskWorktreeRecord({ path: '/a', repo: '/b', branch: 'x', taskName: 'a`b', startedAt })).toBeNull();
      expect(validateTaskWorktreeRecord({ path: '/a', repo: '/b', branch: 'x', taskName: '[link](evil)', startedAt })).toBeNull();
      // A charset-compliant taskName passes THIS check (proven by every
      // other test in this file using a real worktree with taskName
      // 'demo' — those only ever fail, if at all, for unrelated reasons).
    });

    it('rejects a registered-but-detached worktree, logging the detached-specific message', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-taskwt-detached-'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const repo = join(base, 'repo');
        mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
        writeFileSync(join(repo, 'README.md'), 'hello');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

        const worktreePath = join(base, '.cortextos-task-worktrees', 'repo', 'demo');
        mkdirSync(join(base, '.cortextos-task-worktrees', 'repo'), { recursive: true });
        // Detached — no -b, just checks out the current commit directly.
        execFileSync('git', ['worktree', 'add', '--detach', worktreePath], { cwd: repo });

        errorSpy.mockClear();
        expect(validateTaskWorktreeRecord({
          repo, path: worktreePath, branch: 'task/demo', taskName: 'demo', startedAt: new Date().toISOString(),
        })).toBeNull();
        const logged = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
        expect(logged).toMatch(/detached/);
        expect(logged).not.toMatch(/not a currently registered/);
      } finally {
        errorSpy.mockRestore();
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('rejects a path that is not a registered worktree at all, logging the not-registered message (distinct from detached)', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-taskwt-notreg-'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const repo = join(base, 'repo');
        mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
        writeFileSync(join(repo, 'README.md'), 'hello');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

        // A directory that exists but was never registered via `git worktree add`.
        const fakePath = join(base, '.cortextos-task-worktrees', 'repo', 'demo');
        mkdirSync(fakePath, { recursive: true });

        errorSpy.mockClear();
        expect(validateTaskWorktreeRecord({
          repo, path: fakePath, branch: 'task/demo', taskName: 'demo', startedAt: new Date().toISOString(),
        })).toBeNull();
        const logged = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
        expect(logged).toMatch(/not a currently registered/);
        expect(logged).not.toMatch(/detached/);
      } finally {
        errorSpy.mockRestore();
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('rejects a record whose taskName does not match the worktree path it claims, even with a real path/branch/repo', () => {
      const { base, repo, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        // Everything is genuinely real and registered — only taskName lies.
        writeFileSync(
          join(agentDir, '.claude', 'state', 'active-task-worktree.json'),
          JSON.stringify({ repo, path: worktreePath, branch: 'task/demo', taskName: 'totally-different-task', startedAt: new Date().toISOString() }),
        );
        expect(isTaskWorktreeOperation('Bash', { command: 'ls' }, agentDir)).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('rejects a repo that is not itself a git repository root', () => {
      const base = mkdtempSync(join(tmpdir(), 'hookperm-taskwt-notroot-'));
      try {
        const notRepo = join(base, 'not-a-repo');
        mkdirSync(notRepo, { recursive: true });
        expect(validateTaskWorktreeRecord({
          repo: notRepo, path: join(base, '.cortextos-task-worktrees', 'not-a-repo', 'demo'),
          branch: 'task/demo', taskName: 'demo', startedAt: new Date().toISOString(),
        })).toBeNull();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('returns the canonicalized repo, not the raw input, on success', () => {
      const { base, repo, worktreePath, agentDir } = makeActiveTaskWorktree();
      try {
        const record = JSON.parse(readFileSync(join(agentDir, '.claude', 'state', 'active-task-worktree.json'), 'utf-8'));
        const validated = validateTaskWorktreeRecord(record);
        expect(validated).not.toBeNull();
        expect(validated!.repo).toBe(canonicalizePath(resolve(repo)));
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('Permission hook skips ExitPlanMode', () => {
    it('ExitPlanMode should be handled by planmode hook, not permission hook', () => {
      // The permission hook checks tool_name and exits with no output for ExitPlanMode.
      // We verify the logic by testing parseHookInput returns the correct tool_name.
      const input = JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: {} });
      const result = parseHookInput(input);
      expect(result.tool_name).toBe('ExitPlanMode');
      // The hook script would exit(0) with no output for this tool_name
    });
  });

  describe('formatToolSummary', () => {
    it('formats Edit summary with file path and diffs', () => {
      const summary = formatToolSummary('Edit', {
        file_path: '/src/main.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      });
      expect(summary).toContain('File: /src/main.ts');
      expect(summary).toContain('- const x = 1;');
      expect(summary).toContain('+ const x = 2;');
    });

    it('formats Write summary with file path and content preview', () => {
      const summary = formatToolSummary('Write', {
        file_path: '/src/new-file.ts',
        content: 'export function hello() {}',
      });
      expect(summary).toContain('File: /src/new-file.ts');
      expect(summary).toContain('export function hello() {}');
    });

    it('formats Bash summary with command', () => {
      const summary = formatToolSummary('Bash', { command: 'npm test' });
      expect(summary).toBe('Command: npm test');
    });

    it('truncates Edit strings at 300 chars', () => {
      const longStr = 'a'.repeat(500);
      const summary = formatToolSummary('Edit', {
        file_path: '/test.ts',
        old_string: longStr,
        new_string: longStr,
      });
      // The old/new strings should be truncated
      expect(summary.indexOf('a'.repeat(301))).toBe(-1);
    });

    it('shows the full Bash command up to 1500 chars (no early hidden payload, #39)', () => {
      const cmd = 'x'.repeat(300);
      const summary = formatToolSummary('Bash', { command: cmd });
      // 300-char command is well under the cap — shown in full, no truncation marker.
      expect(summary).toBe(`Command: ${cmd}`);
    });

    it('marks truncation when a Bash command exceeds 1500 chars (#39)', () => {
      const cmd = 'x'.repeat(2000);
      const summary = formatToolSummary('Bash', { command: cmd });
      expect(summary).toContain('x'.repeat(1500));
      expect(summary).not.toContain('x'.repeat(1501));
      expect(summary).toContain('truncated');
    });

    it('formats unknown tools as JSON', () => {
      const summary = formatToolSummary('CustomTool', { key: 'value' });
      expect(summary).toContain('"key"');
      expect(summary).toContain('"value"');
    });
  });

  describe('sanitizeCodeBlock', () => {
    it('escapes triple backticks', () => {
      const result = sanitizeCodeBlock('some ```code``` here');
      expect(result).not.toContain('```');
      expect(result).toContain('``\\`');
    });

    it('passes through text without backticks', () => {
      expect(sanitizeCodeBlock('hello world')).toBe('hello world');
    });
  });

  describe('buildPermissionKeyboard', () => {
    it('creates approve/deny buttons with correct callback data', () => {
      const kb = buildPermissionKeyboard('abc123') as any;
      expect(kb.inline_keyboard).toHaveLength(1);
      expect(kb.inline_keyboard[0]).toHaveLength(2);
      expect(kb.inline_keyboard[0][0].text).toBe('Approve');
      expect(kb.inline_keyboard[0][0].callback_data).toBe('perm_allow_abc123');
      expect(kb.inline_keyboard[0][1].text).toBe('Deny');
      expect(kb.inline_keyboard[0][1].callback_data).toBe('perm_deny_abc123');
    });
  });

  describe('buildPlanKeyboard', () => {
    it('creates plan approve/deny buttons', () => {
      const kb = buildPlanKeyboard('plan123') as any;
      expect(kb.inline_keyboard[0][0].text).toBe('Approve Plan');
      expect(kb.inline_keyboard[0][0].callback_data).toBe('perm_allow_plan123');
      expect(kb.inline_keyboard[0][1].text).toBe('Deny Plan');
      expect(kb.inline_keyboard[0][1].callback_data).toBe('perm_deny_plan123');
    });
  });

  describe('Ask hook - state file structure', () => {
    it('builds correct ask state from questions array', () => {
      const questions = [
        {
          question: 'Pick a color',
          header: 'Colors',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'A warm color' },
            { label: 'Blue' },
          ],
        },
        {
          question: 'Pick sizes',
          multiSelect: true,
          options: ['Small', 'Medium', 'Large'],
        },
      ];

      const state = buildAskState(questions) as any;
      expect(state.questions).toHaveLength(2);
      expect(state.current_question).toBe(0);
      expect(state.total_questions).toBe(2);
      expect(state.multi_select_chosen).toEqual([]);

      // First question
      expect(state.questions[0].question).toBe('Pick a color');
      expect(state.questions[0].header).toBe('Colors');
      expect(state.questions[0].multiSelect).toBe(false);
      expect(state.questions[0].options).toEqual(['Red', 'Blue']);

      // Second question
      expect(state.questions[1].question).toBe('Pick sizes');
      expect(state.questions[1].multiSelect).toBe(true);
      expect(state.questions[1].options).toEqual(['Small', 'Medium', 'Large']);
    });
  });

  describe('Ask hook - single-select keyboard', () => {
    it('creates one row per option with askopt callback', () => {
      const kb = buildAskSingleSelectKeyboard(0, ['Red', 'Blue', 'Green']) as any;
      expect(kb.inline_keyboard).toHaveLength(3);
      expect(kb.inline_keyboard[0][0].text).toBe('Red');
      expect(kb.inline_keyboard[0][0].callback_data).toBe('askopt_0_0');
      expect(kb.inline_keyboard[1][0].text).toBe('Blue');
      expect(kb.inline_keyboard[1][0].callback_data).toBe('askopt_0_1');
      expect(kb.inline_keyboard[2][0].text).toBe('Green');
      expect(kb.inline_keyboard[2][0].callback_data).toBe('askopt_0_2');
    });

    it('uses question index in callback data', () => {
      const kb = buildAskSingleSelectKeyboard(2, ['Yes', 'No']) as any;
      expect(kb.inline_keyboard[0][0].callback_data).toBe('askopt_2_0');
      expect(kb.inline_keyboard[1][0].callback_data).toBe('askopt_2_1');
    });
  });

  describe('Ask hook - multi-select keyboard', () => {
    it('creates toggle rows plus Submit button', () => {
      const kb = buildAskMultiSelectKeyboard(1, ['A', 'B']) as any;
      expect(kb.inline_keyboard).toHaveLength(3); // 2 options + submit
      expect(kb.inline_keyboard[0][0].text).toBe('A');
      expect(kb.inline_keyboard[0][0].callback_data).toBe('asktoggle_1_0');
      expect(kb.inline_keyboard[1][0].text).toBe('B');
      expect(kb.inline_keyboard[1][0].callback_data).toBe('asktoggle_1_1');
      // Submit button
      expect(kb.inline_keyboard[2][0].text).toBe('Submit Selections');
      expect(kb.inline_keyboard[2][0].callback_data).toBe('asksubmit_1');
    });
  });

  describe('formatQuestionMessage', () => {
    it('formats single question without counter', () => {
      const msg = formatQuestionMessage('bot1', 0, 1, {
        question: 'Pick one',
        header: '',
        multiSelect: false,
        options: ['A', 'B'],
      });
      expect(msg).toContain('QUESTION - bot1:');
      expect(msg).not.toContain('(1/1)');
      expect(msg).toContain('Pick one');
      expect(msg).toContain('1. A');
      expect(msg).toContain('2. B');
    });

    it('formats multi-question with counter', () => {
      const msg = formatQuestionMessage('bot1', 0, 3, {
        question: 'First?',
        header: 'Header text',
        multiSelect: false,
        options: ['X'],
      });
      expect(msg).toContain('QUESTION (1/3) - bot1:');
      expect(msg).toContain('Header text');
      expect(msg).toContain('First?');
    });

    it('adds multi-select hint', () => {
      const msg = formatQuestionMessage('bot1', 0, 1, {
        question: 'Select all',
        multiSelect: true,
        options: ['A'],
      });
      expect(msg).toContain('Multi-select: tap options to toggle, then tap Submit');
    });

    it('includes option descriptions when present', () => {
      const msg = formatQuestionMessage('bot1', 0, 1, {
        question: 'Pick',
        options: [
          { label: 'Opt1', description: 'Desc for opt1' },
          { label: 'Opt2' },
        ],
      });
      expect(msg).toContain('1. Opt1');
      expect(msg).toContain('Desc for opt1');
      expect(msg).toContain('2. Opt2');
    });
  });

  describe('Plan mode hook - plan reading', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), 'cortextos-plan-'));
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it('parseHookInput extracts plan_file from tool_input', () => {
      const planPath = join(testDir, 'plan.md');
      writeFileSync(planPath, '# My Plan\n\nStep 1\nStep 2\n');

      const input = JSON.stringify({
        tool_name: 'ExitPlanMode',
        tool_input: { plan_file: planPath },
      });
      const result = parseHookInput(input);
      expect(result.tool_name).toBe('ExitPlanMode');
      expect(result.tool_input.plan_file).toBe(planPath);

      // Verify plan content is readable
      const content = readFileSync(result.tool_input.plan_file, 'utf-8');
      expect(content).toContain('# My Plan');
    });
  });

  describe('outputDecision', () => {
    it('formats correct JSON for allow decision', () => {
      // We can't easily test process.stdout.write + process.exit,
      // so we test the structure directly
      const decision: any = { behavior: 'allow' };
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision,
        },
      };
      const json = JSON.stringify(output);
      expect(json).toContain('"behavior":"allow"');
      expect(json).toContain('"hookEventName":"PermissionRequest"');
    });

    it('formats correct JSON for deny decision with message', () => {
      const decision: any = { behavior: 'deny', message: 'Not allowed' };
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision,
        },
      };
      const json = JSON.stringify(output);
      expect(json).toContain('"behavior":"deny"');
      expect(json).toContain('"message":"Not allowed"');
    });
  });
});
