import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { AgentPTY } from './agent-pty.js';
import { KEYS } from './inject.js';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { stripControlChars } from '../utils/validate.js';

const OPENCODE_BOOTSTRAP_PATTERN = 'Ask anything';
const OPENCODE_SESSION_MARKER = 'opencode-session.json';
const OPENCODE_PROCESS_MARKER = 'opencode-process.json';
const STARTUP_INJECT_MAX_ATTEMPTS = 60;
const STARTUP_INJECT_INTERVAL_MS = 500;
const STARTUP_INJECT_MIN_ATTEMPTS = 6;
const STARTUP_INJECT_STABLE_TICKS = 3;
const TELEGRAM_HEADER_PATTERN = /^=== TELEGRAM(?:\s+\w+)?\s+from[^\n]*\(chat_id:(-?\d+)\)/;

/**
 * PTY wrapper for OpenCode agents.
 *
 * OpenCode's terminal runtime is close to Claude Code's PTY shape:
 * - Binary: `opencode`
 * - Fresh startup: `opencode`, then inject the Cortext startup prompt once
 *   the TUI is ready for input.
 * - Continue startup: `opencode --continue`, then inject the Cortext continue
 *   prompt once the TUI is ready.
 * - Optional model: `--model provider/model`
 * - Optional OpenCode agent: `--agent <name>`
 *
 * The adapter intentionally reuses AgentPTY's environment loading, output
 * logging, secret redaction, and message injection path. It only adds
 * OpenCode-specific args and isolated OpenCode XDG roots under cortextOS
 * state, so multiple native agents do not share sessions/auth/cache by
 * accident. `OPENCODE_CONFIG_DIR` remains under the agent directory for
 * agent-local commands/agents/plugins.
 */
export class OpencodePTY extends AgentPTY {
  private stateDir: string;
  private agentDir: string;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    super(env, config, logPath, OPENCODE_BOOTSTRAP_PATTERN);
    this.agentDir = env.agentDir;
    this.stateDir = join(env.ctxRoot, 'state', env.agentName);
  }

  protected getBinaryName(): string {
    if (platform() !== 'win32') return 'opencode';

    const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const ext of ['.exe', '.cmd']) {
      for (const dir of pathDirs) {
        if (existsSync(join(dir, `opencode${ext}`))) {
          return `opencode${ext}`;
        }
      }
    }
    return 'opencode';
  }

  protected buildClaudeArgs(mode: 'fresh' | 'continue', prompt: string): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    if (this.config.opencode_agent) {
      args.push('--agent', this.config.opencode_agent);
    }

    return args;
  }

  protected customizeEnv(env: Record<string, string>): void {
    const opencodeStateRoot = env['OPENCODE_XDG_ROOT'] || join(this.stateDir, 'opencode');
    const xdgDirs = {
      XDG_DATA_HOME: join(opencodeStateRoot, 'data'),
      XDG_CONFIG_HOME: join(opencodeStateRoot, 'config'),
      XDG_STATE_HOME: join(opencodeStateRoot, 'state'),
      XDG_CACHE_HOME: join(opencodeStateRoot, 'cache'),
    };
    for (const [key, dir] of Object.entries(xdgDirs)) {
      mkdirSync(dir, { recursive: true });
      env[key] = dir;
    }

    if (!env['OPENCODE_CONFIG_DIR']) {
      const configDir = join(this.agentDir, '.opencode');
      mkdirSync(configDir, { recursive: true });
      env['OPENCODE_CONFIG_DIR'] = configDir;
    }

    if (!env['GOOGLE_GENERATIVE_AI_API_KEY'] && env['GEMINI_API_KEY']) {
      env['GOOGLE_GENERATIVE_AI_API_KEY'] = env['GEMINI_API_KEY'];
    }
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    // OpenCode exits after completing a launch-time prompt (`--prompt` or
    // `opencode run <message>`). Cortext agents must stay alive for future
    // Telegram, inbox, and cron injections, so start the persistent TUI first
    // and inject the startup prompt through the normal PTY input path.
    this.cleanupStaleProcessMarker();
    await super.spawn(mode, '');
    this.writeSessionMarker(mode);
    this.writeProcessMarker();
    if (prompt.trim()) {
      this.injectStartupPromptWhenReady(prompt);
    }
  }

  override kill(): void {
    try {
      super.kill();
    } finally {
      this.removeProcessMarker();
    }
  }

  override injectMessage(content: string): void {
    // OpenCode v1.17.9's TUI does not reliably surface content delivered with
    // bracketed paste (`ESC[200~ ... ESC[201~`): sandbox validation showed the
    // shared injector could repaint the screen without the inbound message
    // reaching the input box. Raw typed input does reach the TUI. Strip terminal
    // control sequences before typing so external Telegram/bus text cannot
    // smuggle escape codes now that we intentionally bypass bracketed paste.
    const safeContent = this.prepareInjectedContent(content);
    const maxChunk = 4096;
    for (let i = 0; i < safeContent.length; i += maxChunk) {
      this.write(safeContent.slice(i, i + maxChunk));
    }
    setTimeout(() => {
      try {
        this.write(KEYS.ENTER);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[opencode-pty] deferred Enter failed (pty likely torn down): ${msg}`);
      }
    }, 300).unref?.();
  }

  private prepareInjectedContent(content: string): string {
    const safeContent = stripControlChars(content).replace(/\r\n?/g, '\n');
    const telegramMatch = safeContent.match(TELEGRAM_HEADER_PATTERN);
    if (!telegramMatch) return safeContent;

    const chatId = telegramMatch[1];
    return `${safeContent}

[OPENCODE TELEGRAM DELIVERY REQUIREMENT]
This is a real Telegram inbound message. A plain answer printed only in the OpenCode TUI is NOT delivered to the user and is a failed reply.
You MUST deliver your response by executing exactly one terminal command:

cortextos bus send-telegram ${chatId} '<your reply>'

Keep the reply concise. Do not just write the answer in the OpenCode chat.`;
  }

  private injectStartupPromptWhenReady(prompt: string): void {
    let attempts = 0;
    let stableTicks = 0;
    let lastRecentLength = 0;
    const timer = setInterval(() => {
      attempts++;
      const recent = this.getOutputBuffer().getRecent();
      const cleaned = recent.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const cleanedForReadiness = cleaned
        .split('\n')
        .filter((line) => !line.startsWith('[opencode-pty]'))
        .join('\n');
      const recentLength = recent.length;
      stableTicks = recentLength === lastRecentLength ? stableTicks + 1 : 0;
      lastRecentLength = recentLength;

      const hasRendered = cleanedForReadiness.trim().length > 0;
      const knownPromptReady = cleanedForReadiness.includes('Ask anything')
        || cleanedForReadiness.includes('ctrl+p commands');
      const quiescentTuiReady = attempts >= STARTUP_INJECT_MIN_ATTEMPTS
        && hasRendered
        && stableTicks >= STARTUP_INJECT_STABLE_TICKS;
      const ready = knownPromptReady || quiescentTuiReady;

      if (ready) {
        clearInterval(timer);
        try {
          this.injectMessage(prompt);
        } catch {
          // If the TUI exited during startup, AgentProcess exit handling will
          // decide whether to recover. The lost startup prompt is preferable to
          // crashing the daemon.
        }
      } else if (attempts >= STARTUP_INJECT_MAX_ATTEMPTS) {
        clearInterval(timer);
        this.getOutputBuffer().push('[opencode-pty] startup prompt not injected: TUI readiness not detected\n');
      }
    }, STARTUP_INJECT_INTERVAL_MS);
    timer.unref?.();
  }

  private writeSessionMarker(mode: 'fresh' | 'continue'): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const markerPath = join(this.stateDir, OPENCODE_SESSION_MARKER);
      writeFileSync(markerPath, JSON.stringify({
        runtime: 'opencode',
        mode,
        updated_at: new Date().toISOString(),
      }, null, 2) + '\n', 'utf-8');
    } catch {
      // Non-fatal: missing marker only makes the next boot start fresh.
    }
  }

  private processMarkerPath(): string {
    return join(this.stateDir, OPENCODE_PROCESS_MARKER);
  }

  private writeProcessMarker(): void {
    const pid = this.getPid();
    if (!pid) return;
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.processMarkerPath(), JSON.stringify({
        runtime: 'opencode',
        pid,
        updated_at: new Date().toISOString(),
      }, null, 2) + '\n', 'utf-8');
    } catch {
      // Non-fatal: the marker is only a cleanup aid after daemon crashes.
    }
  }

  private removeProcessMarker(): void {
    try {
      unlinkSync(this.processMarkerPath());
    } catch {
      // Already gone.
    }
  }

  private cleanupStaleProcessMarker(): void {
    try {
      const markerPath = this.processMarkerPath();
      if (!existsSync(markerPath)) return;
      const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as { pid?: unknown };
      const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
      if (pid && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Missing process or permission failure; either way do not block boot.
        }
      }
      unlinkSync(markerPath);
    } catch {
      // A corrupt marker must not block the agent from starting.
    }
  }
}

export function opencodeSessionExists(ctxRoot: string, agentName: string): boolean {
  return existsSync(join(ctxRoot, 'state', agentName, OPENCODE_SESSION_MARKER));
}
