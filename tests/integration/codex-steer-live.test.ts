import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WsUnixJsonRpcClient } from '../../src/utils/ws-unix-client.js';

/**
 * LIVE integration test for mid-turn steer against a real `codex app-server`.
 *
 * Gated behind CODEX_STEER_LIVE=1 because it needs the codex CLI installed and
 * authenticated, and burns real model tokens:
 *
 *   CODEX_STEER_LIVE=1 npx vitest run tests/integration/codex-steer-live.test.ts
 *
 * Asserts the plan's integration matrix:
 *   (a) turn/steer accepted mid-turn (RPC success, same turnId returned)
 *   (b) no second turn/started before turn/completed (no fork/restart)
 *   (c) final output references the steered content
 *   (d) steer with a stale/unknown expectedTurnId is rejected (queue-fallback race)
 */
const LIVE = process.env.CODEX_STEER_LIVE === '1';

(LIVE ? describe : describe.skip)('codex app-server mid-turn steer (live)', () => {
  let proc: ChildProcess | null = null;
  let rpc: WsUnixJsonRpcClient;
  let workDir: string;
  let socketPath: string;
  let threadId: string;

  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

  function notificationsOf(method: string) {
    return notifications.filter((n) => n.method === method);
  }

  async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'codex-steer-live-'));
    socketPath = join(workDir, 'steer.sock');

    proc = spawn('codex', ['app-server', '--listen', 'unix://./steer.sock'], {
      cwd: workDir,
      stdio: 'ignore',
    });

    await waitFor(() => existsSync(socketPath), 15000, 'app-server socket');

    rpc = new WsUnixJsonRpcClient(socketPath);
    rpc.onMessage((message) => {
      const m = message as { method?: string; params?: Record<string, unknown>; id?: unknown };
      if (m.method && m.id === undefined) {
        notifications.push({ method: m.method, params: m.params ?? {} });
      }
    });
    await rpc.connect();

    await rpc.request('initialize', {
      clientInfo: { name: 'cortextos-steer-test', title: 'steer test', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');

    const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: workDir,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sessionStartSource: 'startup',
      persistExtendedHistory: false,
    });
    threadId = started.result!.thread.id;
  }, 60000);

  afterAll(() => {
    try {
      rpc?.close();
    } catch { /* ignore */ }
    proc?.kill();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('steers an active turn without forking it and the output reflects the steer', async () => {
    // Kick off a turn long enough to steer: an explicit shell sleep keeps the
    // model busy deterministically.
    const turnDone = rpc.request('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Run the shell command `sleep 8` and wait for it to finish. Then reply with exactly one short sentence.',
        text_elements: [],
      }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite' },
    });

    await waitFor(() => notificationsOf('turn/started').length === 1, 30000, 'turn/started');
    const activeTurnId = (notificationsOf('turn/started')[0].params.turn as { id: string }).id;

    const steer = await rpc.request<{ turnId: string }>('turn/steer', {
      threadId,
      expectedTurnId: activeTurnId,
      input: [{
        type: 'text',
        text: 'Additional instruction: include the word PINEAPPLE in your final sentence.',
        text_elements: [],
      }],
    });

    // (a) steer accepted, same turn id — no fork
    expect(steer.error).toBeUndefined();
    expect(steer.result?.turnId).toBe(activeTurnId);

    await waitFor(() => notificationsOf('turn/completed').length === 1, 120000, 'turn/completed');
    await turnDone;

    // (b) the steered input never started a second turn
    expect(notificationsOf('turn/started')).toHaveLength(1);

    // (c) final agent output references the steered content
    const agentText = notifications
      .filter((n) => n.method === 'item/completed')
      .map((n) => (n.params.item as { type?: string; text?: string } | undefined))
      .filter((item) => item?.type === 'agentMessage')
      .map((item) => item!.text ?? '')
      .join('\n');
    expect(agentText.toUpperCase()).toContain('PINEAPPLE');
  }, 180000);

  it('rejects steer with a stale expectedTurnId (fallback race is detectable)', async () => {
    // No active turn: any expectedTurnId must be rejected, which is the signal
    // the adapter uses to fall back to queueing.
    await expect(rpc.request('turn/steer', {
      threadId,
      expectedTurnId: 'turn-that-does-not-exist',
      input: [{ type: 'text', text: 'should not land', text_elements: [] }],
    })).rejects.toThrow();
  }, 30000);
});
