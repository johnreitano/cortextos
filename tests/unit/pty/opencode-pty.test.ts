import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
};

let spawnCall: { file: string; args: string[]; options: any } | null = null;
const mockPty = {
  pid: 42,
  write: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
  resize: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get mkdirSync() { return fsMocks.mkdirSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get readdirSync() { return fsMocks.readdirSync; },
  };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockImplementation((file: string, args: string[], options: any) => {
    spawnCall = { file, args, options };
    return mockPty;
  }),
}));

const { OpencodePTY, opencodeSessionExists } = await import('../../../src/pty/opencode-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'opencode-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/opencode-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  spawnCall = null;
  mockPty.write.mockClear();
  mockPty.onData.mockClear();
  mockPty.onExit.mockClear();
  mockPty.kill.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.mkdirSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
  fsMocks.readFileSync.mockReset();
  fsMocks.readdirSync.mockReset().mockReturnValue([]);
});

describe('OpencodePTY', () => {
  function installSpawnMock(pty: OpencodePTY): void {
    (pty as unknown as { spawnFn: typeof mockSpawn }).spawnFn = mockSpawn;
  }

  const mockSpawn = (file: string, args: string[], options: any) => {
    spawnCall = { file, args, options };
    return mockPty;
  };

  it('returns opencode as the binary name', () => {
    const pty = new OpencodePTY(mockEnv, {});
    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('opencode');
  });

  it('builds fresh args with --model and --agent but no launch-time prompt', () => {
    const pty = new OpencodePTY(mockEnv, {
      model: 'anthropic/claude-sonnet-4',
      opencode_agent: 'build',
    });
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');

    expect(args).toEqual([
      '--model', 'anthropic/claude-sonnet-4',
      '--agent', 'build',
    ]);
  });

  it('adds --continue in continue mode without passing a launch-time prompt', () => {
    const pty = new OpencodePTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('continue', 'resume me');

    expect(args).toEqual(['--continue']);
  });

  it('starts the persistent TUI without a launch-time prompt', async () => {
    const pty = new OpencodePTY(mockEnv, {
      model: 'openai/gpt-4.1-nano',
      opencode_agent: 'build',
    });
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot prompt');

    expect(spawnCall?.args).toEqual([
      '--model', 'openai/gpt-4.1-nano',
      '--agent', 'build',
    ]);
  });

  it('sets OPENCODE_CONFIG_DIR under the agent directory when spawning', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.file).toBe('opencode');
    expect(spawnCall?.options.env.OPENCODE_CONFIG_DIR)
      .toBe('/tmp/fw/orgs/acme/agents/opencode-agent/.opencode');
  });

  it('isolates OpenCode data, config, state, and cache under cortextOS agent state', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/data');
    expect(spawnCall?.options.env.XDG_CONFIG_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/config');
    expect(spawnCall?.options.env.XDG_STATE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/state');
    expect(spawnCall?.options.env.XDG_CACHE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/cache');
  });

  it('overrides inherited XDG roots so OpenCode state stays agent-isolated by default', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env') {
        return [
          'XDG_DATA_HOME=/global/data',
          'XDG_CONFIG_HOME=/global/config',
          'XDG_STATE_HOME=/global/state',
          'XDG_CACHE_HOME=/global/cache',
          '',
        ].join('\n');
      }
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/data');
    expect(spawnCall?.options.env.XDG_CONFIG_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/config');
    expect(spawnCall?.options.env.XDG_STATE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/state');
    expect(spawnCall?.options.env.XDG_CACHE_HOME)
      .toBe('/tmp/ctx/state/opencode-agent/opencode/cache');
  });

  it('supports an explicit OPENCODE_XDG_ROOT override for custom isolated roots', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/fw/orgs/acme/agents/opencode-agent/.env') {
        return 'OPENCODE_XDG_ROOT=/custom/opencode\n';
      }
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME).toBe('/custom/opencode/data');
    expect(spawnCall?.options.env.XDG_CONFIG_HOME).toBe('/custom/opencode/config');
    expect(spawnCall?.options.env.XDG_STATE_HOME).toBe('/custom/opencode/state');
    expect(spawnCall?.options.env.XDG_CACHE_HOME).toBe('/custom/opencode/cache');
  });

  it('keeps OPENCODE_CONFIG_DIR under the agent directory even when working_directory differs', async () => {
    const pty = new OpencodePTY(mockEnv, { working_directory: '/tmp/project-checkout' });
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.cwd).toBe('/tmp/project-checkout');
    expect(spawnCall?.options.env.OPENCODE_CONFIG_DIR)
      .toBe('/tmp/fw/orgs/acme/agents/opencode-agent/.opencode');
  });

  it('maps GEMINI_API_KEY to OpenCode Google provider env name when needed', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === '/tmp/fw/orgs/acme/secrets.env');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/fw/orgs/acme/secrets.env') return 'GEMINI_API_KEY=gemini-secret\n';
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('gemini-secret');
  });

  it('writes a session marker and synthetic bootstrap line after spawn', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/tmp/ctx/state/opencode-agent', { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      '/tmp/ctx/state/opencode-agent/opencode-session.json',
      expect.stringContaining('"runtime": "opencode"'),
      'utf-8',
    );
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('injects the startup prompt only after real TUI output is quiescent', async () => {
    vi.useFakeTimers();
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', 'boot prompt');

      expect(mockPty.write).not.toHaveBeenCalled();
      pty.getOutputBuffer().push('OpenCode rendered frame\n');
      await vi.advanceTimersByTimeAsync(STARTUP_TICKS(9));

      expect(mockPty.write.mock.calls.map((call) => call[0]).join('')).toContain('boot prompt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not blindly inject the startup prompt when TUI readiness is never detected', async () => {
    vi.useFakeTimers();
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', 'boot prompt');

      await vi.advanceTimersByTimeAsync(STARTUP_TICKS(65));

      expect(mockPty.write).not.toHaveBeenCalled();
      expect(pty.getOutputBuffer().getRecent()).toContain('startup prompt not injected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up a stale recorded OpenCode process before spawning a replacement', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    fsMocks.existsSync.mockImplementation((path: string) =>
      path === '/tmp/ctx/state/opencode-agent/opencode-process.json');
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/ctx/state/opencode-agent/opencode-process.json') {
        return JSON.stringify({ pid: 24680 });
      }
      return '';
    });

    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');

      expect(killSpy).toHaveBeenCalledWith(24680, 'SIGTERM');
      expect(fsMocks.unlinkSync).toHaveBeenCalledWith('/tmp/ctx/state/opencode-agent/opencode-process.json');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('removes the recorded OpenCode process marker on explicit kill', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', '');

    pty.kill();

    expect(mockPty.kill).toHaveBeenCalled();
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith('/tmp/ctx/state/opencode-agent/opencode-process.json');
  });
});

function STARTUP_TICKS(count: number): number {
  return count * 500;
}

describe('opencodeSessionExists', () => {
  it('checks the cortextOS state marker for this agent', () => {
    const expected = join('/tmp/ctx', 'state', 'opencode-agent', 'opencode-session.json');
    fsMocks.existsSync.mockImplementation((path: string) => path === expected);

    expect(opencodeSessionExists('/tmp/ctx', 'opencode-agent')).toBe(true);
  });
});
