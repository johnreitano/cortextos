import { AgentManager } from './agent-manager.js';
import { IPCServer } from './ipc-server.js';
import { readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir } from '../utils/atomic.js';
import {
  sweepAgents,
  shouldAlert,
  fsReaders,
  type AgentLiveness,
  type AgentVerdict,
  type FreshnessState,
} from './freshness-monitor.js';

// Each fast-checker registers a process-level SIGUSR1 handler (see
// fast-checker.ts:102). With >10 active agents the default Node listener cap
// trips MaxListenersExceededWarning. Bump for the full fleet.
process.setMaxListeners(20);

// ---------------------------------------------------------------------------
// Crash handling: turn silent daemon deaths into attributable, observable
// events. Three responsibilities:
//   1. Write a .daemon-crashed marker per agent — hook-crash-alert.ts uses
//      this on the next session boot to emit "🚨 daemon crashed" instead of
//      the misleading "🚨 agent crashed" default.
//   2. Maintain a small crash-history JSON so we can detect crash-loops.
//   3. On ≥3 crashes in 15 min, send ONE Telegram alert to the operator chat
//      (with a 30-min cooldown). PM2's max_restarts: 10 is the final
//      circuit breaker; our alert fires before the fleet goes fully dead.
// Context: root cause of 2026-04-22 restart storm was unguarded this.pty!
// in worker-process.ts:93 — PR #196 fixed 3 sister sites but missed this
// one. The inject.ts try/catch + worker-process ?. land the structural fix;
// this module is the visibility layer.
// ---------------------------------------------------------------------------

export interface CrashEvent { ts: string; err: string; }
export interface CrashHistory { crashes: CrashEvent[]; lastAlertAt?: string; }

export const CRASH_HISTORY_MAX = 20;
export const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000;    // 15 min detection window
export const CRASH_LOOP_THRESHOLD = 3;                  // 3 crashes trips the alert
export const CRASH_LOOP_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min between alerts
const TELEGRAM_SEND_TIMEOUT_MS = 3000;           // bounded — we're crashing

export function crashHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.daemon-crash-history.json');
}

export function readCrashHistory(ctxRoot: string): CrashHistory {
  const p = crashHistoryPath(ctxRoot);
  if (!existsSync(p)) return { crashes: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CrashHistory;
    return { crashes: parsed.crashes ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { crashes: [] };
  }
}

export function writeCrashHistory(ctxRoot: string, history: CrashHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(crashHistoryPath(ctxRoot), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // disk full / permission issue — don't block exit
    console.error('[daemon] Failed to persist crash history (non-fatal)');
  }
}

export function recordCrash(ctxRoot: string, errStr: string): CrashHistory {
  const history = readCrashHistory(ctxRoot);
  history.crashes.push({ ts: new Date().toISOString(), err: errStr.slice(0, 2000) });
  if (history.crashes.length > CRASH_HISTORY_MAX) {
    history.crashes = history.crashes.slice(-CRASH_HISTORY_MAX);
  }
  writeCrashHistory(ctxRoot, history);
  return history;
}

export function shouldSendCrashLoopAlert(history: CrashHistory): boolean {
  const now = Date.now();
  const windowStart = now - CRASH_LOOP_WINDOW_MS;
  const recent = history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
  if (recent < CRASH_LOOP_THRESHOLD) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRASH_LOOP_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}

export function countRecentCrashes(history: CrashHistory): number {
  const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
  return history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
}

export function writeDaemonCrashedMarkers(ctxRoot: string): void {
  // Scan state/ for per-agent dirs (each agent has state/<name>/ created
  // by AgentProcess). Writing here parallels the .daemon-stop marker path
  // in agent-manager.ts:stopAll — lets hook-crash-alert.ts distinguish
  // crash from planned stop. Each write is independently try/catch'd so
  // a single bad agent dir can't block the exit path.
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return;
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return; }
  const ts = new Date().toISOString();
  for (const name of names) {
    try {
      writeFileSync(join(stateDir, name, '.daemon-crashed'), ts, 'utf-8');
    } catch { /* swallow per-agent */ }
  }
}

function getOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null {
  // Priority 1: explicit operator env (recommended for production).
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken };
  }
  // Priority 2: fall back to the first agent's .env. Good enough for
  // small single-operator installs — alert still lands SOMEWHERE visible.
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return null;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const a of agents) {
        const envFile = join(agentsRoot, a.name, '.env');
        if (!existsSync(envFile)) continue;
        try {
          const content = readFileSync(envFile, 'utf-8');
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = envChat || chatMatch[1].trim();
          if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
            return { chatId, botToken };
          }
        } catch { /* skip this agent */ }
      }
    }
  } catch { /* fall through */ }
  return null;
}

function sendCrashLoopAlertBestEffort(
  frameworkRoot: string,
  crashCount: number,
  errStr: string,
): boolean {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[daemon] Crash-loop alert: no operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return false;
  }
  const message =
    `🚨 CRITICAL: cortextos daemon is crash-looping\n` +
    `${crashCount} crashes in 15 minutes\n` +
    `Last error: ${errStr.slice(0, 500)}\n` +
    `Next alert in 30 min if the pattern continues.`;
  try {
    const r = spawnSync('curl', [
      '-s', '--max-time', '3',
      '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      '--data-urlencode', `text=${message}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
    if (r.status === 0) {
      console.error('[daemon] Crash-loop alert sent to operator chat');
      return true;
    }
    console.error('[daemon] Crash-loop alert send failed (non-fatal)');
    return false;
  } catch {
    return false;
  }
}

// ─── Heartbeat-freshness monitor (the PID-vs-freshness fix) ───────────────────

/** How often the daemon sweeps agent heartbeat freshness. Well under the wedged
 *  threshold (~10h on a 4h loop) so a crossing surfaces promptly; a sweep is a
 *  few small file reads, so 10 min is cheap. Detection latency is bounded by the
 *  heartbeat interval, not this — see freshness-monitor.ts. */
const FRESHNESS_SWEEP_MS = 10 * 60_000;
/** Re-alert cadence while an agent stays in the same stale state (so a
 *  persistent wedge nags periodically rather than every 10-min sweep). */
const FRESHNESS_REALERT_MS = 6 * 60 * 60_000;

/** Telegram the operator that an agent is wedged/escalated. Best-effort; the log
 *  line is the backstop if no operator chat is configured. Mirrors the crash-loop
 *  alert path. */
function sendFreshnessAlertBestEffort(frameworkRoot: string, v: AgentVerdict): void {
  const creds = getOperatorChatCreds(frameworkRoot);
  const icon = v.state === 'escalate' ? '🔴' : '🟠';
  const head = v.state === 'escalate' ? 'WEDGED — likely needs restart' : 'WEDGED (process alive, loop stalled)';
  if (!creds) {
    console.error(`[daemon] Freshness alert (${v.name}): no operator chat configured — ${v.reason}`);
    return;
  }
  const message =
    `${icon} cortextOS agent ${v.name}: ${head}\n` +
    `${v.reason}\n` +
    `The process is alive but its heartbeat has gone stale — it is not processing crons. ` +
    `${v.state === 'escalate' ? 'Consider a soft-restart.' : 'Watching; will escalate if it worsens.'}`;
  try {
    const r = spawnSync('curl', [
      '-s', '--max-time', '3', '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      '--data-urlencode', `text=${message}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
    if (r.status === 0) console.error(`[daemon] Freshness alert sent for ${v.name} (${v.state})`);
    else console.error(`[daemon] Freshness alert send failed for ${v.name} (non-fatal)`);
  } catch {
    console.error(`[daemon] Freshness alert threw for ${v.name} (non-fatal)`);
  }
}

/**
 * Shared fatal-error handler for both uncaughtException and
 * unhandledRejection. Performs marker writes + crash recording + optional
 * telegram alert, then optionally exits. Stays fully synchronous so it
 * finishes before Node's default crash behavior triggers.
 */
function handleFatal(
  tag: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  ctxRoot: string,
  frameworkRoot: string,
  doExit: boolean,
): void {
  const errStr = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[daemon] FATAL ${tag} — exiting for PM2 respawn`);
  console.error(errStr);

  writeDaemonCrashedMarkers(ctxRoot);
  const history = recordCrash(ctxRoot, errStr);

  if (shouldSendCrashLoopAlert(history)) {
    const recent = countRecentCrashes(history);
    if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, errStr)) {
      history.lastAlertAt = new Date().toISOString();
      writeCrashHistory(ctxRoot, history);
    }
  }

  if (doExit) process.exit(1);
}

/**
 * cortextOS Daemon - single process managing all agents.
 * Run via `pm2 start ecosystem.config.js` or `cortextos ecosystem && pm2 start`.
 */
class Daemon {
  private agentManager: AgentManager | null = null;
  private ipcServer: IPCServer | null = null;
  private instanceId: string;
  private ctxRoot: string;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  /** Last freshness alert per agent, for the transition/cooldown logic. */
  private freshnessAlertLog = new Map<string, { state: FreshnessState; atMs: number }>();

  /**
   * One heartbeat-freshness sweep across all agents. Reads each agent's
   * heartbeat.json / crons.json / lifecycle markers, classifies wedged-vs-healthy
   * (PID-alive is necessary but NOT sufficient — the whole point of the fix), and
   * alerts the operator on wedged/escalate with transition + cooldown dedup.
   * Injectable nowMs for tests; wrapped so a sweep error can never crash the daemon.
   */
  runFreshnessSweep(frameworkRoot: string, nowMs: number = Date.now()): AgentVerdict[] {
    if (!this.agentManager) return [];
    const agents: AgentLiveness[] = this.agentManager.getAllStatuses().map((s) => ({
      name: s.name,
      pidAlive: s.status === 'running',
      stateDir: join(this.ctxRoot, 'state', s.name),
    }));
    const verdicts = sweepAgents(agents, fsReaders, nowMs);
    for (const v of verdicts) {
      if (shouldAlert(v, this.freshnessAlertLog.get(v.name), nowMs, FRESHNESS_REALERT_MS)) {
        sendFreshnessAlertBestEffort(frameworkRoot, v);
        this.freshnessAlertLog.set(v.name, { state: v.state, atMs: nowMs });
      } else if (v.state === 'healthy' || v.state === 'crashed') {
        // Recovered / handed to the crash path — clear so a future wedge re-alerts.
        this.freshnessAlertLog.delete(v.name);
      }
    }
    return verdicts;
  }

  constructor() {
    this.instanceId = process.env.CTX_INSTANCE_ID || 'default';
    // Always derive ctxRoot from instanceId to avoid inheriting a parent cortextOS's CTX_ROOT
    this.ctxRoot = join(homedir(), '.cortextos', this.instanceId);
  }

  async start(): Promise<void> {
    // Force restrictive default permissions for everything the daemon writes:
    // 0700 dirs, 0600 files. Belt-and-suspenders for explicit chmod calls.
    if (process.platform !== 'win32') {
      process.umask(0o077);
    }

    console.log(`[daemon] Starting cortextOS daemon (instance: ${this.instanceId})`);

    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || '';
    const org = process.env.CTX_ORG || '';

    if (!frameworkRoot) {
      console.error('[daemon] CTX_FRAMEWORK_ROOT not set');
      process.exit(1);
    }

    // Write PID file
    const pidFile = join(this.ctxRoot, 'daemon.pid');
    ensureDir(this.ctxRoot);
    writeFileSync(pidFile, String(process.pid), 'utf-8');
    if (process.platform !== 'win32') {
      try {
        chmodSync(pidFile, 0o600);
      } catch { /* best effort */ }
    }

    // Create agent manager
    this.agentManager = new AgentManager(this.instanceId, this.ctxRoot, frameworkRoot, org);

    // Start IPC server
    this.ipcServer = new IPCServer(this.agentManager, this.instanceId);
    await this.ipcServer.start();

    // Discover and start agents
    await this.agentManager.discoverAndStart();

    console.log(`[daemon] Running (pid: ${process.pid})`);

    // Heartbeat-freshness monitor: the daemon is the only always-live cross-agent
    // vantage, so the wedge check lives here (an agent cannot monitor its own
    // stall). unref() so it never keeps the process alive on its own.
    this.freshnessTimer = setInterval(() => {
      try {
        this.runFreshnessSweep(frameworkRoot);
      } catch (err) {
        console.error('[daemon] Freshness sweep error (non-fatal):', err);
      }
    }, FRESHNESS_SWEEP_MS);
    this.freshnessTimer.unref?.();
    console.log(`[daemon] Heartbeat-freshness monitor started (sweep every ${FRESHNESS_SWEEP_MS / 60_000}m)`);

    // Handle shutdown signals
    const shutdown = async () => {
      console.log('[daemon] Shutting down...');
      if (this.freshnessTimer) {
        clearInterval(this.freshnessTimer);
        this.freshnessTimer = null;
      }
      try {
        if (this.agentManager) {
          await this.agentManager.stopAll();
        }
      } catch (err) {
        console.error('[daemon] Error during shutdown:', err);
      }
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      // Clean up PID file
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
      process.exit(0);
    };

    // BUG-003 fix: re-entrancy guard. A second SIGTERM arriving while
    // shutdown() is in flight would start a parallel stopAll(), causing
    // unpredictable signal cascades across child PTY processes.
    let shuttingDown = false;
    const handleSignal = () => {
      if (shuttingDown) {
        console.log('[daemon] Shutdown already in progress, ignoring signal');
        return;
      }
      shuttingDown = true;
      shutdown().catch((err) => {
        console.error('[daemon] Fatal shutdown error:', err);
        process.exit(1);
      });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    // Global fatal-error handlers. uncaughtException exits for PM2 respawn.
    // unhandledRejection logs + records but does not exit (rejected promises
    // shouldn't be fatal by default; matches Node 15+ behavior without
    // adopting the new strict default). Both paths write .daemon-crashed
    // markers and increment the crash-loop counter.
    const ctxRootForHandler = this.ctxRoot;
    const frameworkRootForHandler = frameworkRoot;
    process.on('uncaughtException', (err) => {
      handleFatal('uncaughtException', err, ctxRootForHandler, frameworkRootForHandler, true);
    });
    process.on('unhandledRejection', (reason) => {
      handleFatal('unhandledRejection', reason, ctxRootForHandler, frameworkRootForHandler, false);
    });
    console.log('[daemon] Fatal-error handlers registered (uncaughtException + unhandledRejection)');

    // Debug-only: SIGUSR2 induces a controlled uncaughtException for
    // live crash-path verification. Off in production unless
    // CTX_DEBUG_ALLOW_CRASH_TRIGGER=1 is explicitly set. See docs/debugging.md.
    if (process.env.CTX_DEBUG_ALLOW_CRASH_TRIGGER === '1') {
      process.on('SIGUSR2', () => {
        console.error('[daemon] SIGUSR2 received — inducing test crash (CTX_DEBUG_ALLOW_CRASH_TRIGGER=1)');
        throw new Error('Simulated daemon crash via SIGUSR2 (test harness)');
      });
      console.log('[daemon] SIGUSR2 crash trigger ENABLED (debug mode)');
    }

    // Fallback cleanup on exit (belt-and-suspenders for Windows)
    process.on('exit', () => {
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
    });
  }
}

// Only auto-start when run directly (e.g. `node dist/daemon.js` or via PM2).
// Guarding with require.main prevents accidental daemon spawn when the module
// is require()'d for testing or class imports — which would start a full daemon
// with TelegramPollers, IPC server, and Claude PTY processes as a side effect.
// See: https://github.com/grandamenium/cortextos/issues/44
if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().catch(err => {
    console.error('[daemon] Fatal error:', err);
    process.exit(1);
  });
}
