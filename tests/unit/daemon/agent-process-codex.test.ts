import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockImplementation(() => capturedOnExit?.(0, undefined)),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(null),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const mockCodexSessionExists = vi.fn().mockReturnValue(false);
vi.mock('../../../src/pty/codex-pty.js', () => ({
  CodexPTY: function CodexPTY() { return mockPty; },
  codexSessionExists: (...args: unknown[]) => mockCodexSessionExists(...args),
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockCodexSessionExists.mockReset().mockReturnValue(false);
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockReset().mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess - Codex runtime', () => {
  it('spawns in fresh mode when no Codex cwd session exists', async () => {
    mockCodexSessionExists.mockReturnValue(false);
    const ap = new AgentProcess('codex-agent', mockEnv, { runtime: 'codex' });

    await ap.start();

    expect(mockCodexSessionExists).toHaveBeenCalledWith(mockEnv.agentDir);
    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('spawns in continue mode when a Codex cwd session exists', async () => {
    mockCodexSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('codex-agent', mockEnv, { runtime: 'codex' });

    await ap.start();

    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('stops Codex without sending Claude REPL commands', async () => {
    const ap = new AgentProcess('codex-agent', mockEnv, { runtime: 'codex' });
    await ap.start();

    await ap.stop();

    expect(mockPty.write).not.toHaveBeenCalledWith('\x03');
    expect(mockPty.write).not.toHaveBeenCalledWith('/exit\r\n');
    expect(mockPty.kill).toHaveBeenCalled();
  });
});
