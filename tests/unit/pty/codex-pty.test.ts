import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get mkdirSync() { return fsMocks.mkdirSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
  };
});

const execFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync,
}));

// Stub node-pty so CodexPTY can be imported without a native addon
vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 77,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  }),
}));

const { CodexPTY, codexSessionExists } = await import('../../../src/pty/codex-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.mkdirSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  execFileSync.mockReset();
});

describe('codexSessionExists', () => {
  it('returns false when Codex state DB is absent', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(codexSessionExists('/tmp/work')).toBe(false);
  });

  it('queries state_5.sqlite for a non-archived cwd session', () => {
    const expectedPath = join(homedir(), '.codex', 'state_5.sqlite');
    fsMocks.existsSync.mockReturnValue(true);
    execFileSync.mockReturnValue('thread-id\n');

    expect(codexSessionExists("/tmp/paul's-work")).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'sqlite3',
      [
        expectedPath,
        "SELECT id FROM threads WHERE cwd = '/tmp/paul''s-work' AND archived = 0 ORDER BY updated_at DESC LIMIT 1;",
      ],
      { encoding: 'utf-8', timeout: 3000 },
    );
  });

  it('returns false when sqlite lookup fails', () => {
    fsMocks.existsSync.mockReturnValue(true);
    execFileSync.mockImplementation(() => {
      throw new Error('sqlite3 missing');
    });

    expect(codexSessionExists('/tmp/work')).toBe(false);
  });
});

describe('CodexPTY typing-indicator wiring (issue #330)', () => {
  function makeStubApi() {
    return { sendChatAction: vi.fn().mockResolvedValue(undefined) };
  }

  it('does not fire sendChatAction when no Telegram handle is set', () => {
    const pty = new CodexPTY(mockEnv, {});
    // No setTelegramHandle call → maybeFireTyping must be a no-op
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    expect(true).toBe(true); // no throw, no API call possible
  });

  it('fires sendChatAction once on a non-completion JSONL event', () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = makeStubApi();
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();

    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
    expect(api.sendChatAction).toHaveBeenCalledWith('12345', 'typing');
  });

  it('rate-limits sendChatAction to one call per 4s', () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = makeStubApi();
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    // Three rapid back-to-back fires inside the 4s window
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();

    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
  });

  it('fires again after the 4s window elapses', () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = makeStubApi();
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    // Force first fire's timestamp into the past by reaching into the field.
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    expect(api.sendChatAction).toHaveBeenCalledTimes(1);

    // Roll the rate-limit clock back by 5s to simulate elapsed wall time.
    (pty as unknown as { _typingLastSent: number })._typingLastSent = Date.now() - 5000;
    (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping();
    expect(api.sendChatAction).toHaveBeenCalledTimes(2);
  });

  it('swallows sendChatAction rejections silently (non-fatal)', async () => {
    const pty = new CodexPTY(mockEnv, {});
    const api = { sendChatAction: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')) };
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');

    // Must not throw
    expect(() => (pty as unknown as { maybeFireTyping(): void }).maybeFireTyping()).not.toThrow();
    // Allow the rejected promise to settle so vitest doesn't flag an unhandled rejection
    await new Promise((r) => setTimeout(r, 0));
    expect(api.sendChatAction).toHaveBeenCalled();
  });
});

describe('CodexPTY bootstrap pattern', () => {
  it('isBootstrapped() fires on thread.started JSONL', () => {
    const pty = new CodexPTY(mockEnv, {});
    pty.getOutputBuffer().push('{"type":"thread.started","id":"abc"}\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('isBootstrapped() stays false on unrelated output', () => {
    const pty = new CodexPTY(mockEnv, {});
    pty.getOutputBuffer().push('loading codex...\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
  });

  it('builds fresh exec args with features, model, and prompt', () => {
    const pty = new CodexPTY(mockEnv, { model: 'gpt-5-codex' });
    const args = (pty as unknown as { buildFreshArgs(prompt: string): string[] })
      .buildFreshArgs('hello');

    expect(args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      '--json',
      '--enable', 'goals',
      '--model', 'gpt-5-codex',
      'hello',
    ]);
  });

  it('builds resume exec args with --last and noninteractive bypass', () => {
    const pty = new CodexPTY(mockEnv, {});
    const args = (pty as unknown as { buildResumeArgs(prompt: string): string[] })
      .buildResumeArgs('next');

    expect(args).toEqual([
      'exec',
      'resume',
      '--last',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--enable', 'goals',
      'next',
    ]);
  });
});
