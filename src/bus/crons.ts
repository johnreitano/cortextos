/**
 * crons.ts — Cron definitions file I/O module (Subtask 1.2).
 *
 * All operations are synchronous and atomic (via atomicWriteSync).
 * Each agent has its own crons.json at:
 *   {CTX_ROOT}/{CRONS_DIRECTORY}/{agentName}/{CRONS_FILENAME}
 *
 * Disk format (envelope — matching CronStateFile shape from cron-state.ts):
 *   { "updated_at": "<ISO>", "crons": CronDefinition[] }
 *
 * Read always returns [] on missing file or parse failure (graceful degradation).
 * Corrupted JSON triggers a stderr warning so operators can investigate.
 *
 * Write always goes through atomicWriteSync (mkdir + tmp rename).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CronDefinition } from '../types/index.js';
import { CRONS_DIRECTORY, CRONS_FILENAME } from './crons-schema.js';
import { atomicWriteSync } from '../utils/atomic.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Disk envelope shape — keeps metadata separate from the cron array. */
interface CronsFile {
  updated_at: string;
  crons: CronDefinition[];
}

/**
 * Resolve the absolute path to an agent's crons.json.
 *
 * Uses CTX_ROOT env var when available (production), otherwise falls back to
 * a path relative to process.cwd() so tests can supply their own root via
 * process.env.CTX_ROOT pointing to a tempdir.
 */
function cronsFilePath(agentName: string): string {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  return join(ctxRoot, CRONS_DIRECTORY, agentName, CRONS_FILENAME);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all cron definitions for an agent from disk.
 *
 * @returns Array of CronDefinition objects.  Returns [] when the file is
 *          absent or cannot be parsed — never throws.
 */
export function readCrons(agentName: string): CronDefinition[] {
  const filePath = cronsFilePath(agentName);
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'crons' in parsed &&
      Array.isArray((parsed as CronsFile).crons)
    ) {
      return (parsed as CronsFile).crons;
    }
    // File exists but envelope shape is wrong — treat as empty
    process.stderr.write(
      `[crons] WARNING: crons.json for agent "${agentName}" has unexpected shape; treating as empty.\n`
    );
    return [];
  } catch (err) {
    process.stderr.write(
      `[crons] WARNING: failed to parse crons.json for agent "${agentName}" — treating as empty. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return [];
  }
}

/**
 * Write (replace) all cron definitions for an agent atomically.
 *
 * Always updates the envelope's `updated_at` to the current UTC time.
 */
export function writeCrons(agentName: string, crons: CronDefinition[]): void {
  const filePath = cronsFilePath(agentName);
  const envelope: CronsFile = {
    updated_at: new Date().toISOString(),
    crons,
  };
  atomicWriteSync(filePath, JSON.stringify(envelope, null, 2));
}

/**
 * Add a new cron definition for an agent.
 *
 * @throws {Error} if a cron with the same name already exists for the agent.
 */
export function addCron(agentName: string, cron: CronDefinition): void {
  const existing = readCrons(agentName);
  const collision = existing.find(c => c.name === cron.name);
  if (collision !== undefined) {
    throw new Error(`cron "${cron.name}" already exists for agent "${agentName}"`);
  }
  writeCrons(agentName, [...existing, cron]);
}

/**
 * Remove a cron by name for an agent.
 *
 * @returns `true` if the cron was found and removed; `false` if it did not exist.
 *          Never throws (idempotent).
 */
export function removeCron(agentName: string, name: string): boolean {
  const existing = readCrons(agentName);
  const idx = existing.findIndex(c => c.name === name);
  if (idx === -1) {
    return false;
  }
  const updated = [...existing.slice(0, idx), ...existing.slice(idx + 1)];
  writeCrons(agentName, updated);
  return true;
}

/**
 * Patch an existing cron definition with new field values.
 *
 * Merges `patch` into the matching cron object using `Object.assign` semantics
 * (shallow merge).  The `name` field in `patch` is ignored — the cron is
 * looked up by the `name` parameter and the stored name is never changed.
 *
 * @returns `true` if the cron was found and updated; `false` if it did not exist.
 */
export function updateCron(
  agentName: string,
  name: string,
  patch: Partial<CronDefinition>
): boolean {
  const existing = readCrons(agentName);
  const idx = existing.findIndex(c => c.name === name);
  if (idx === -1) {
    return false;
  }
  const updated = existing.map((c, i) =>
    i === idx ? { ...c, ...patch, name: c.name } : c
  );
  writeCrons(agentName, updated);
  return true;
}

/**
 * Look up a single cron by name for an agent.
 *
 * @returns The CronDefinition if found, `undefined` otherwise.
 */
export function getCronByName(
  agentName: string,
  name: string
): CronDefinition | undefined {
  return readCrons(agentName).find(c => c.name === name);
}
