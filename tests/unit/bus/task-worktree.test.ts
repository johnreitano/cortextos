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

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { startTaskWorktree, finishTaskWorktree } from '../../../src/bus/task-worktree';
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
  base = mkdtempSync(join(tmpdir(), 'cortextos-taskwt-test-'));
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
    // approval-creation work even starts — this is the load-bearing
    // ordering guarantee the whole design depends on.
    expect(existsSync(statePath())).toBe(false);
    await resultPromise;
    expect(existsSync(worktreePath)).toBe(false);
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
    // Branch itself must survive a 'merge' finish — only the worktree checkout is removed.
    const branches = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf-8' });
    expect(branches).toContain(branch.replace('task/', ''));
  });

  it('deletes the branch on abandon and does not request approval', async () => {
    const { path: worktreePath, branch } = startTaskWorktree(agentDir, repo, 'demo');
    const result = await finishTaskWorktree(agentDir, paths, 'orchestrator', 'leadio', 'abandon');
    expect(existsSync(worktreePath)).toBe(false);
    expect(result.approvalId).toBeUndefined();
    const branches = execFileSync('git', ['branch', '--list', branch], { cwd: repo, encoding: 'utf-8' });
    expect(branches.trim()).toBe('');
  });
});
