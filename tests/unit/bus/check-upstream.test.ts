import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { checkUpstream } from '../../../src/bus/metrics';

/**
 * checkUpstream decided "updates_available" from the heads merely being
 * DIFFERENT, which is true whichever way the divergence runs. Being ahead of
 * upstream therefore reported as having updates to pull, and the diff shown
 * was the local repo's own commits seen from upstream's side — its "deletions"
 * were local additions.
 */
describe('checkUpstream — direction of divergence', () => {
  let repo: string;
  let upstream: string;

  const git = (cmd: string, cwd: string) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe', encoding: 'utf-8' });

  beforeEach(() => {
    upstream = mkdtempSync(join(tmpdir(), 'ctx-upstream-'));
    git('init -q', upstream);
    git('config user.email "t@t.com"', upstream);
    git('config user.name "T"', upstream);
    git('checkout -q -b main', upstream);
    writeFileSync(join(upstream, 'base.txt'), 'base\n');
    git('add .', upstream);
    git('commit -q -m base', upstream);

    repo = mkdtempSync(join(tmpdir(), 'ctx-local-'));
    git(`clone -q ${upstream} .`, repo);
    git('config user.email "t@t.com"', repo);
    git('config user.name "T"', repo);
    git(`remote add upstream ${upstream}`, repo);
    git('fetch -q upstream', repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
  });

  it('reports up_to_date when the heads are identical', () => {
    const result = checkUpstream(repo);

    expect(result.status).toBe('up_to_date');
  });

  // The reported bug: 24 commits ahead, 0 to pull, reported as updates_available
  // with a 2,772-deletion diff that was actually our own work.
  it('reports up_to_date and names the direction when local is AHEAD', () => {
    writeFileSync(join(repo, 'mine.txt'), 'my own work\n');
    git('add .', repo);
    git('commit -q -m "local work upstream does not have"', repo);

    const result = checkUpstream(repo);

    expect(result.status).toBe('up_to_date');
    expect(result.commits).toBe(0);
    expect(result.ahead).toBe(1);
    expect(result.message).toContain('ahead');
  });

  it('still reports updates_available when upstream genuinely has commits', () => {
    writeFileSync(join(upstream, 'theirs.txt'), 'upstream work\n');
    git('add .', upstream);
    git('commit -q -m "real upstream change"', upstream);
    git('fetch -q upstream', repo);

    const result = checkUpstream(repo);

    expect(result.status).toBe('updates_available');
    expect(result.commits).toBe(1);
  });

  it('reports updates_available when both sides have diverged', () => {
    writeFileSync(join(upstream, 'theirs.txt'), 'upstream work\n');
    git('add .', upstream);
    git('commit -q -m "upstream change"', upstream);
    writeFileSync(join(repo, 'mine.txt'), 'local work\n');
    git('add .', repo);
    git('commit -q -m "local change"', repo);
    git('fetch -q upstream', repo);

    const result = checkUpstream(repo);

    expect(result.status).toBe('updates_available');
    expect(result.commits).toBe(1);
  });
});
