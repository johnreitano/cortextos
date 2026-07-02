import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const repoRoot = process.cwd();
const featureRoot = join(repoRoot, '.agent', 'one-big-feature', 'opencode-native-agent');

function readAllFiles(dir: string): Array<{ path: string; content: string }> {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readAllFiles(path));
    } else {
      files.push({ path, content: readFileSync(path, 'utf-8') });
    }
  }
  return files;
}

describe('OpenCode production validation artifacts', () => {
  it('keeps the full-parity validation packet tracked under .agent', () => {
    expect(existsSync(featureRoot)).toBe(true);
    expect(existsSync(join(featureRoot, '00-discovery.md'))).toBe(true);
    expect(existsSync(join(featureRoot, '02-master-plan.md'))).toBe(true);
    expect(existsSync(join(featureRoot, '04-implementation', 'production-e2e-matrix.md'))).toBe(true);
    expect(existsSync(join(featureRoot, '05-reviews', 'designer-test-prompt-draft.md'))).toBe(true);
  });

  it('does not describe the production-grade validation as a canary', () => {
    const files = readAllFiles(featureRoot);
    for (const file of files) {
      expect(file.content, file.path).not.toMatch(/\bcanary\b/i);
      expect(file.content, file.path).not.toContain('opencode-canary');
      expect(file.content, file.path).not.toMatch(/opencode-production\s+validation/);
      expect(file.content, file.path).not.toMatch(/full-parity-production\s+validation/);
    }
  });

  it('keeps live build and daemon restart behind an explicit approval gate', () => {
    const files = readAllFiles(featureRoot);
    const combined = files.map((file) => file.content).join('\n');

    expect(combined).toContain('Do not run `npm run build`');
    expect(combined).toContain('explicit approval');
    expect(combined).toContain('backup');
    expect(combined).toContain('rollback');
  });
});
