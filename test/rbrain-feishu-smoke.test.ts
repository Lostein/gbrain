import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

let cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

function writeRbrainConfig(home: string): void {
  mkdirSync(join(home, '.rbrain'), { recursive: true });
  writeFileSync(
    join(home, '.rbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, 'brain.pglite'),
      embedding_disabled: true,
      schema_pack: 'rbrain-feishu',
    }, null, 2) + '\n',
    'utf-8',
  );
}

function writeFakeLarkCli(dir: string): void {
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "lark-cli fake 1.0.44"
  exit 0
fi
if [ "\${1:-}" = "doctor" ]; then
  echo '{"ok":true}'
  exit 0
fi
if [ "\${1:-}" = "calendar" ] && [ "\${2:-}" = "+agenda" ]; then
  echo '{"items":[{"title":"Daily planning","start":"2026-06-02T09:00:00+08:00"}]}'
  exit 0
fi
echo '{"items":[]}'
`;
  const file = join(dir, 'lark-cli');
  writeFileSync(file, script, 'utf-8');
  chmodSync(file, 0o755);
}

function runRbrain(
  args: string[],
  opts: { home: string; fakeBin: string },
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', ['run', 'src/rbrain.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      RBRAIN_HOME: opts.home,
      PATH: `${opts.fakeBin}:${process.env.PATH ?? ''}`,
    },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJsonStdout<T>(result: { code: number; stdout: string; stderr: string }): T {
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

describe('rbrain feishu smoke', () => {
  test('setup, pull agenda, sync, status, and source-scoped search form a usable loop', () => {
    const home = makeTempDir('rbrain-feishu-home-');
    const mirror = makeTempDir('rbrain-feishu-mirror-');
    const fakeBin = makeTempDir('rbrain-feishu-fake-bin-');
    writeRbrainConfig(home);
    writeFakeLarkCli(fakeBin);

    const setup = parseJsonStdout<{
      status: 'ok';
      source: { status: string; schema_pack?: string };
      mirror: { git: { repository: string; commit: string } };
    }>(runRbrain([
      'feishu',
      'setup',
      '--path',
      mirror,
      '--source-id',
      'feishu',
      '--name',
      'Feishu',
      '--json',
    ], { home, fakeBin }));
    expect(setup.status).toBe('ok');
    expect(setup.source.status).toBe('created');
    expect(setup.mirror.git.repository).toBe('initialized');
    expect(setup.mirror.git.commit).toBe('created');

    const sourcePack = runRbrain(['config', 'get', 'schema_pack.source.feishu'], { home, fakeBin });
    expect(sourcePack.code, sourcePack.stderr).toBe(0);
    expect(sourcePack.stdout.trim()).toBe('rbrain-feishu');

    const prePullStatus = parseJsonStdout<{
      status: 'warn';
      next: string[];
    }>(runRbrain(['feishu', 'status', '--source-id', 'feishu', '--json'], { home, fakeBin }));
    expect(prePullStatus.status).toBe('warn');
    expect(prePullStatus.next).toContain('rbrain feishu refresh');

    const pull = parseJsonStdout<{
      status: 'ok';
      kind: 'agenda';
      commit: string;
      sync: { status: string; added: number };
    }>(runRbrain([
      'feishu',
      'pull',
      'agenda',
      '--source-id',
      'feishu',
      '--sync',
      '--json',
    ], { home, fakeBin }));
    expect(pull.status).toBe('ok');
    expect(pull.kind).toBe('agenda');
    expect(pull.commit).toBe('created');
    expect(pull.sync.status).toBe('first_sync');
    expect(pull.sync.added).toBeGreaterThanOrEqual(1);

    const readyStatus = parseJsonStdout<{
      status: 'ok';
      source: { schema_pack: string; last_sync_at: string | null };
      mirror: { snapshots: Array<{ domain: string; markdown_files: number }> };
    }>(runRbrain(['feishu', 'status', '--source-id', 'feishu', '--json'], { home, fakeBin }));
    expect(readyStatus.status).toBe('ok');
    expect(readyStatus.source.schema_pack).toBe('rbrain-feishu');
    expect(readyStatus.source.last_sync_at).toBeTruthy();
    expect(readyStatus.mirror.snapshots.find((s) => s.domain === 'calendar')?.markdown_files).toBe(1);

    const ailyDryRun = parseJsonStdout<{
      status: 'ok';
      dry_run: boolean;
      candidates: number;
      assets: Array<{ action: string; title: string }>;
    }>(runRbrain([
      'feishu',
      'aily',
      'push-space',
      '--space-id',
      'knowledge_space_test',
      '--dry-run',
      '--json',
    ], { home, fakeBin }));
    expect(ailyDryRun.dry_run).toBe(true);
    expect(ailyDryRun.candidates).toBe(1);
    expect(ailyDryRun.assets[0]!.action).toBe('dry_run_create');
    expect(ailyDryRun.assets[0]!.title).toMatch(/\.txt$/);

    const search = runRbrain(['search', 'planning', '--source', 'feishu', '--limit', '5'], { home, fakeBin });
    expect(search.code, search.stderr).toBe(0);
    expect(search.stdout).toContain('Daily planning');
    expect(search.stdout).toContain('feishu/calendar/');
  }, 30_000);
});
