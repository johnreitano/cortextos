import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
  };
});

// Stub node-pty so HermesPTY can be imported without a native addon
vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 99,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  }),
}));

const { hermesDbExists, HermesPTY } = await import('../../../src/pty/hermes-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'hermes-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/hermes-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.writeFileSync.mockReset();
});

describe('hermesDbExists', () => {
  it('returns false when ~/.hermes/state.db does not exist', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists()).toBe(false);
  });

  it('returns true when ~/.hermes/state.db exists', () => {
    const expectedPath = join(homedir(), '.hermes', 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists()).toBe(true);
  });

  it('uses HERMES_HOME override when provided', () => {
    const customHome = '/custom/hermes';
    const expectedPath = join(customHome, 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists(customHome)).toBe(true);
  });

  it('returns false when HERMES_HOME is set but state.db is absent', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists('/custom/hermes')).toBe(false);
  });
});

describe('HermesPTY', () => {
  it('getBinaryName returns "hermes"', () => {
    const pty = new HermesPTY(mockEnv, {});
    // Access protected method via cast
    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('hermes');
  });

  it('buildClaudeArgs returns [] for fresh mode', () => {
    const pty = new HermesPTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');
    expect(args).toEqual([]);
  });

  it('buildClaudeArgs returns ["--continue"] for continue mode', () => {
    const pty = new HermesPTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('continue', 'hello');
    expect(args).toEqual(['--continue']);
  });

  it('isBootstrapped() fires on "❯" in output', () => {
    const pty = new HermesPTY(mockEnv, {});
    pty.getOutputBuffer().push('⚔ ❯ ');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('isBootstrapped() does not fire on output without "❯"', () => {
    const pty = new HermesPTY(mockEnv, {});
    pty.getOutputBuffer().push('loading...');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
  });
});
