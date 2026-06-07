import { afterEach, describe, expect, test } from 'bun:test';
import matter from 'gray-matter';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { defaultManagedRegistryPath, recordManagedSyncResult, saveManagedRegistry, createEmptyManagedRegistry } from '../src/core/feishu-managed-registry.ts';
import {
  FEISHU_DOCTOR_CAPABILITY_CHECKS,
  FEISHU_MIRROR_DIRS,
  buildAilyEnvExample,
  buildAilyAssetTitle,
  buildAilyOverviewMarkdown,
  buildApprovalInitiatedMarkdown,
  buildApprovalInitiatedScript,
  buildApprovalTasksMarkdown,
  buildApprovalTasksScript,
  buildAgendaScript,
  buildAgendaMarkdown,
  buildAutoCommitShellFunction,
  buildBaseFieldsMarkdown,
  buildBaseFieldsScript,
  buildBaseRecordsMarkdown,
  buildBaseRecordsScript,
  buildBaseSearchMarkdown,
  buildBaseSearchScript,
  buildBaseTablesMarkdown,
  buildBaseTablesScript,
  buildDocScript,
  buildDocListManifestTemplate,
  buildDocListScript,
  buildDocMarkdown,
  buildDriveSearchMarkdown,
  buildDriveSearchScript,
  buildImChatListMarkdown,
  buildImChatListScript,
  buildImChatMessagesMarkdown,
  buildImChatMessagesScript,
  buildImChatSearchMarkdown,
  buildImChatSearchScript,
  buildImFlagsMarkdown,
  buildImFlagsScript,
  buildImMessageSearchMarkdown,
  buildImMessageSearchScript,
  buildMailTriageMarkdown,
  buildMailTriageScript,
  buildMirrorReadme,
  buildMirrorGitignore,
  buildMinutesSearchScript,
  buildMinutesSearchMarkdown,
  buildOkrCycleDetailMarkdown,
  buildOkrCycleDetailScript,
  buildOkrCyclesMarkdown,
  buildOkrCyclesScript,
  buildRefreshScript,
  buildTasksScript,
  buildTasksMarkdown,
  buildWikiNodesMarkdown,
  buildWikiNodesScript,
  buildWikiSpacesMarkdown,
  buildWikiSpacesScript,
  collectAilyPushCandidates,
  expandPath,
  normalizeDocSlug,
  parseDocManifest,
  pushAilyKnowledgeSpace,
} from '../src/commands/feishu.ts';

const cleanupPaths: string[] = [];

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

describe('rbrain feishu command helpers', () => {
  test('mirror layout includes Feishu work domains used by rbrain-feishu pack', () => {
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/docs');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/drive');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/wiki');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/minutes');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/calendar');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/tasks');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/im');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/mail');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/base');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/approvals');
    expect(FEISHU_MIRROR_DIRS).toContain('feishu/okr');
  });

  test('doctor capability checks cover every Feishu collector family', () => {
    const ids = FEISHU_DOCTOR_CAPABILITY_CHECKS.map((check) => check.id);
    expect(ids).toContain('collector:calendar-agenda');
    expect(ids).toContain('collector:docs-fetch');
    expect(ids).toContain('collector:drive-search');
    expect(ids).toContain('collector:wiki-spaces');
    expect(ids).toContain('collector:minutes-search');
    expect(ids).toContain('collector:mail-triage');
    expect(ids).toContain('collector:approval-tasks');
    expect(ids).toContain('collector:okr-cycles');
    expect(ids).toContain('collector:base-records');
    expect(ids).toContain('collector:im-message-search');
  });

  test('README points users at the rbrain source setup path', async () => {
    await withEnv({ RBRAIN_MODE: '1' }, () => {
      const body = buildMirrorReadme('/tmp/rbrain-feishu');
      expect(body).toContain('rbrain feishu setup --path "/tmp/rbrain-feishu"');
      expect(body).toContain('rbrain sync --source feishu');
      expect(body).toContain('feishu/minutes/');
      expect(body).toContain('pull-feishu-tasks.sh');
      expect(body).toContain('pull-feishu-docs-list.sh');
      expect(body).toContain('pull-feishu-drive-search.sh');
      expect(body).toContain('pull-feishu-wiki-spaces.sh');
      expect(body).toContain('pull-feishu-wiki-nodes.sh');
      expect(body).toContain('pull-feishu-mail-triage.sh');
      expect(body).toContain('pull-feishu-approval-tasks.sh');
      expect(body).toContain('pull-feishu-okr-cycles.sh');
      expect(body).toContain('pull-feishu-base-tables.sh');
      expect(body).toContain('pull-feishu-base-records.sh');
      expect(body).toContain('pull-feishu-im-message-search.sh');
      expect(body).toContain('pull-feishu-im-chat-messages.sh');
      expect(body).toContain('refresh-feishu.sh');
      expect(body).toContain('feishu aily push-space --space-id knowledge_space_xxx --dry-run');
      expect(body).toContain('copy `.env.aily.example` to `.env`');
    });
  });

  test('mirror env templates keep real Aily secrets out of Git', () => {
    expect(buildMirrorGitignore()).toContain('.env\n');
    expect(buildMirrorGitignore()).toContain('.env.*\n');
    expect(buildMirrorGitignore()).toContain('!.env.*.example');
    expect(buildMirrorGitignore()).toContain('.rbrain-managed/');
    expect(buildAilyEnvExample()).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_ID=knowledge_space_xxx');
    expect(buildAilyEnvExample()).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN=');
    expect(buildAilyEnvExample()).not.toContain('DWL');
  });

  test('agenda script writes feishu-calendar markdown with provenance', () => {
    const body = buildAgendaScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-calendar');
    expect(body).toContain('captured_via: lark-cli');
    expect(body).toContain('lark-cli calendar +agenda --format json');
    expect(body).toContain('feishu/calendar');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update agenda $DAY"');
  });

  test('doc script writes feishu-doc markdown with provenance', () => {
    const body = buildDocScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-doc');
    expect(body).toContain('lark-cli docs +fetch --api-version v2');
    expect(body).toContain('captured_via: lark-cli');
    expect(body).toContain('feishu/docs');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update doc $SLUG"');
  });

  test('docs-list script delegates to rbrain with a manifest file', async () => {
    await withEnv({ RBRAIN_MODE: '1' }, () => {
      const script = buildDocListScript('/tmp/rbrain-feishu');
      const manifest = buildDocListManifestTemplate();
      expect(script).toContain('feishu pull docs-list --path "$ROOT" --source-id "$SOURCE_ID" --file "$FILE"');
      expect(script).toContain('FILE="${1:-$ROOT/feishu/docs/docs-list.tsv}"');
      expect(manifest).toContain('<feishu-doc-url-or-token><TAB><slug>');
    });
  });

  test('minutes script writes feishu-minutes markdown with provenance', () => {
    const body = buildMinutesSearchScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-minutes');
    expect(body).toContain('lark-cli "${ARGS[@]}"');
    expect(body).toContain('captured_via: lark-cli');
    expect(body).toContain('feishu/minutes');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update minutes search $STAMP"');
  });

  test('drive search script writes feishu-drive markdown with provenance', () => {
    const body = buildDriveSearchScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-drive');
    expect(body).toContain('drive +search --format json');
    expect(body).toContain('captured_via: lark-cli');
    expect(body).toContain('feishu/drive');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update drive search $STAMP"');
  });

  test('wiki space script writes feishu-wiki markdown with provenance', () => {
    const body = buildWikiSpacesScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-wiki');
    expect(body).toContain('wiki_scope: spaces');
    expect(body).toContain('wiki +space-list --format json');
    expect(body).toContain('feishu/wiki');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update wiki spaces $STAMP"');
  });

  test('wiki node script writes feishu-wiki markdown with provenance', () => {
    const body = buildWikiNodesScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-wiki');
    expect(body).toContain('wiki_scope: nodes');
    expect(body).toContain('wiki +node-list --format json');
    expect(body).toContain('--space-id "$SPACE_ID"');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update wiki nodes $STAMP"');
  });

  test('mail triage script writes feishu-mail markdown with provenance', () => {
    const body = buildMailTriageScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-mail');
    expect(body).toContain('mail +triage --format json --max');
    expect(body).toContain('captured_via: lark-cli');
    expect(body).toContain('feishu/mail');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update mail triage $STAMP"');
  });

  test('approval scripts write feishu-approval markdown with provenance', () => {
    const tasks = buildApprovalTasksScript('/tmp/rbrain-feishu');
    const initiated = buildApprovalInitiatedScript('/tmp/rbrain-feishu');
    expect(tasks).toContain('type: feishu-approval');
    expect(tasks).toContain('approval_scope: tasks');
    expect(tasks).toContain('approval tasks query --format json');
    expect(initiated).toContain('approval_scope: initiated');
    expect(initiated).toContain('approval instances initiated --format json');
  });

  test('okr scripts write feishu-okr markdown with provenance', () => {
    const cycles = buildOkrCyclesScript('/tmp/rbrain-feishu');
    const detail = buildOkrCycleDetailScript('/tmp/rbrain-feishu');
    expect(cycles).toContain('type: feishu-okr');
    expect(cycles).toContain('okr_scope: cycles');
    expect(cycles).toContain('okr +cycle-list --format json');
    expect(detail).toContain('okr_scope: cycle-detail');
    expect(detail).toContain('okr +cycle-detail --format json --cycle-id "$CYCLE_ID"');
  });

  test('base scripts write feishu-base markdown with redacted provenance', () => {
    const tables = buildBaseTablesScript('/tmp/rbrain-feishu');
    const fields = buildBaseFieldsScript('/tmp/rbrain-feishu');
    const records = buildBaseRecordsScript('/tmp/rbrain-feishu');
    const search = buildBaseSearchScript('/tmp/rbrain-feishu');
    expect(tables).toContain('type: feishu-base');
    expect(tables).toContain('base_scope: tables');
    expect(tables).toContain('base +table-list --base-token "$BASE_TOKEN"');
    expect(tables).toContain('source_command: lark-cli base +table-list --base-token <redacted>');
    expect(fields).toContain('base_scope: fields');
    expect(records).toContain('base_scope: records');
    expect(records).toContain('base +record-list --format json');
    expect(search).toContain('base_scope: search');
    expect(search).toContain('base +record-search --format json');
  });

  test('im scripts write feishu-im markdown with provenance', () => {
    const chatList = buildImChatListScript('/tmp/rbrain-feishu');
    const chatSearch = buildImChatSearchScript('/tmp/rbrain-feishu');
    const chatMessages = buildImChatMessagesScript('/tmp/rbrain-feishu');
    const messageSearch = buildImMessageSearchScript('/tmp/rbrain-feishu');
    const flags = buildImFlagsScript('/tmp/rbrain-feishu');
    expect(chatList).toContain('type: feishu-im');
    expect(chatList).toContain('im_scope: chat-list');
    expect(chatList).toContain('im +chat-list --format json');
    expect(chatSearch).toContain('im_scope: chat-search');
    expect(chatMessages).toContain('im_scope: chat-messages');
    expect(chatMessages).toContain('im +chat-messages-list --format json');
    expect(messageSearch).toContain('im_scope: message-search');
    expect(messageSearch).toContain('im +messages-search --format json');
    expect(flags).toContain('im_scope: flags');
    expect(flags).toContain('im +flag-list --format json');
  });

  test('tasks script writes feishu-task markdown with provenance', () => {
    const body = buildTasksScript('/tmp/rbrain-feishu');
    expect(body).toContain('type: feishu-task');
    expect(body).toContain('lark-cli "${ARGS[@]}"');
    expect(body).toContain('task +get-my-tasks --format json --page-all');
    expect(body).toContain('commit_snapshot "$OUT" "feishu: update tasks $DAY"');
  });

  test('refresh script delegates to rbrain feishu refresh for the mirror', async () => {
    await withEnv({ RBRAIN_MODE: '1' }, () => {
      const body = buildRefreshScript('/tmp/rbrain-feishu');
      expect(body).toContain('RBRAIN_BIN="${RBRAIN_BIN:-rbrain}"');
      expect(body).toContain('feishu refresh --path "$ROOT" --source-id "$SOURCE_ID"');
      expect(body).toContain('ROOT="/tmp/rbrain-feishu"');
    });
  });

  test('help path includes daily refresh command', async () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/rbrain.ts', 'feishu', '--help'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain('refresh [--source-id feishu]');
    expect(stdout).toContain('optional search/wiki/mail/OKR/approval/Base/IM');
    expect(stdout).toContain('--drive-query TEXT');
    expect(stdout).toContain('--mail-query TEXT');
    expect(stdout).toContain('--wiki-space-id SPACE');
    expect(stdout).toContain('--approval-tasks');
    expect(stdout).toContain('--okr-cycles');
    expect(stdout).toContain('pull <agenda|approval-initiated|approval-tasks|base-fields|base-records|base-search|base-tables|doc|docs-list|drive-search|im-chat-list|im-chat-messages|im-chat-search|im-flags|im-message-search|mail-triage|minutes-search|okr-cycle-detail|okr-cycles|tasks|wiki-nodes|wiki-spaces>');
    expect(stdout).toContain('pull docs-list --file <manifest.tsv>');
    expect(stdout).toContain('pull drive-search [--query TEXT]');
    expect(stdout).toContain('pull wiki-spaces [--page-all]');
    expect(stdout).toContain('pull wiki-nodes [--space-id SPACE]');
    expect(stdout).toContain('pull mail-triage [--query TEXT]');
    expect(stdout).toContain('pull approval-tasks [--params JSON]');
    expect(stdout).toContain('pull okr-cycles [--time-range');
    expect(stdout).toContain('pull base-records --base-token TOKEN');
    expect(stdout).toContain('pull im-message-search [--query TEXT]');
    expect(stdout).toContain('status [--source-id feishu]');
    expect(stdout).toContain('Show Feishu mirror/source readiness');
    expect(stdout).toContain('aily push-space [--space-id knowledge_space_xxx]');
    expect(stdout).toContain('--env-file FILE');
    expect(stdout).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN');
    expect(stdout).toContain('managed sync [--path DIR]');
    expect(stdout).toContain('Prototype a Feishu-native managed asset registry');
    expect(stdout).toContain('managed base-template [--json]');
    expect(stdout).toContain('managed provision-base --base-token TOKEN');
  });

  test('Aily push candidates convert mirror markdown to deterministic txt assets', () => {
    const root = makeTempDir('rbrain-feishu-aily-');
    const dir = join(root, 'feishu', 'docs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'roadmap.md');
    writeFileSync(file, [
      '---',
      'type: feishu-doc',
      'title: Roadmap',
      'feishu_url: https://example.feishu.cn/docx/abc',
      '---',
      '',
      '# Roadmap',
      '',
      'Planning notes.',
      '',
    ].join('\n'), 'utf-8');

    const candidates = collectAilyPushCandidates(root);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.relative_path).toBe('feishu/rbrain-feishu-overview.md');
    expect(candidates[0]!.title).toBe(buildAilyAssetTitle('feishu/rbrain-feishu-overview.md'));
    expect(candidates[0]!.title).toMatch(/\.txt$/);
    expect(candidates[0]!.source_url).toBe('https://rbrain.local/feishu-mirror/feishu/rbrain-feishu-overview.md');
    expect(candidates[0]!.content_sha256).toHaveLength(64);
    expect(candidates[0]!.bytes).toBe(Buffer.byteLength(buildAilyOverviewMarkdown(), 'utf-8'));
    expect(candidates[1]!.relative_path).toBe('feishu/docs/roadmap.md');
    expect(candidates[1]!.title).toBe(buildAilyAssetTitle('feishu/docs/roadmap.md'));
    expect(candidates[1]!.title).toMatch(/\.txt$/);
    expect(candidates[1]!.source_url).toBe('https://example.feishu.cn/docx/abc');
    expect(candidates[1]!.content_sha256).toHaveLength(64);
  });

  test('Aily push creates missing assets without leaking the API token', async () => {
    const root = makeTempDir('rbrain-feishu-aily-create-');
    const dir = join(root, 'feishu', 'calendar');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-06-04.md'), '# Daily agenda\n\nPlanning notes.\n', 'utf-8');

    const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | null }> = [];
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, init: init ?? {}, body });
      if (init?.method === 'GET') {
        return new Response(JSON.stringify({
          status_code: '0',
          data: { knowledge_assets: [], has_more: false, total: 0 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status_code: '0',
        data: { knowledge_asset: { knowledge_asset_id: 'knowledge_asset_test', status: 'learning' } },
      }), { status: 200 });
    };

    const result = await pushAilyKnowledgeSpace({
      root,
      host: 'https://apaas.feishu.cn',
      knowledgeSpaceId: 'knowledge_space_test',
      token: 'secret-token',
      fetchImpl: fakeFetch,
    });

    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    const posts = calls.filter((call) => call.init.method === 'POST');
    expect(posts).toHaveLength(2);
    expect((posts[0]!.init.headers as Record<string, string>)['x-api-token']).toBe('secret-token');
    expect(posts[0]!.body?.knowledge_space_id).toBe('knowledge_space_test');
    expect(String(posts[0]!.body?.title)).toMatch(/\.txt$/);
    const uploadedBodies = posts.map((post) => Buffer.from(String(post.body?.content), 'base64').toString('utf-8'));
    expect(uploadedBodies.some((body) => body.includes('RBrain Feishu Mirror Overview'))).toBe(true);
    expect(uploadedBodies.some((body) => body.includes('rbrain feishu aily push-space'))).toBe(true);
    expect(uploadedBodies.some((body) => body.includes('Daily agenda'))).toBe(true);
  });

  test('Aily push skips existing assets unless replace is requested', async () => {
    const root = makeTempDir('rbrain-feishu-aily-skip-');
    const dir = join(root, 'feishu', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'my-tasks-2026-06-04.md'), '# Tasks\n', 'utf-8');
    const title = buildAilyAssetTitle('feishu/tasks/my-tasks-2026-06-04.md');
    const overviewTitle = buildAilyAssetTitle('feishu/rbrain-feishu-overview.md');

    const calls: Array<{ method?: string }> = [];
    const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ method: init?.method });
      return new Response(JSON.stringify({
        status_code: '0',
        data: {
          knowledge_assets: [
            { name: overviewTitle, knowledge_asset_id: 'knowledge_asset_overview', status: 'successful' },
            { name: title, knowledge_asset_id: 'knowledge_asset_existing', status: 'successful' },
          ],
          has_more: false,
          total: 2,
        },
      }), { status: 200 });
    };

    const result = await pushAilyKnowledgeSpace({
      root,
      host: 'https://apaas.feishu.cn',
      knowledgeSpaceId: 'knowledge_space_test',
      token: 'secret-token',
      fetchImpl: fakeFetch,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.assets[0]!.action).toBe('skipped_existing');
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  test('managed sync dry-run works from --path without a local RBrain database', () => {
    const root = makeTempDir('rbrain-feishu-managed-');
    const dir = join(root, 'feishu', 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'roadmap.md'), '# Roadmap\n\nPlanning notes.\n', 'utf-8');

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'sync',
        '--path',
        root,
        '--space-id',
        'knowledge_space_test',
        '--dry-run',
        '--json',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      persisted: boolean;
      registry_path: string;
      sync_run: { assets_seen: number; assets_changed: number; assets_uploaded: number };
      aily: { assets: Array<{ action: string; relative_path: string }> };
      base_mirror: { rows: number };
    };
    expect(payload.persisted).toBe(false);
    expect(payload.registry_path).toBe(join(root, '.rbrain-managed', 'registry.json'));
    expect(payload.sync_run.assets_seen).toBe(2);
    expect(payload.sync_run.assets_changed).toBe(2);
    expect(payload.sync_run.assets_uploaded).toBe(0);
    expect(payload.aily.assets.map((asset) => asset.action)).toEqual(['dry_run_create', 'dry_run_create']);
    expect(payload.aily.assets[0]!.relative_path).toBe('feishu/rbrain-feishu-overview.md');
    expect(payload.base_mirror.rows).toBe(2);
    expect(existsSync(payload.registry_path)).toBe(false);
  });

  test('managed base-template prints the status table field contract', () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/rbrain.ts', 'feishu', 'managed', 'base-template', '--json'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      table_name: string;
      fields: Array<{ name: string; type: string }>;
    };
    expect(payload.table_name).toBe('RBrain Managed Assets');
    expect(payload.fields).toContainEqual({ name: 'Source URI', type: 'text' });
    expect(payload.fields).toContainEqual({ name: 'Aily Status', type: 'text' });
  });

  test('managed provision-base creates the Base status table without leaking the token', () => {
    const fakeBin = makeTempDir('rbrain-feishu-provision-base-bin-');
    const logFile = join(fakeBin, 'calls.log');
    const fakeLark = `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "${logFile}"
printf '\\n' >> "${logFile}"
if [ "\${2:-}" = "+table-create" ]; then
  echo '{"data":{"table":{"table_id":"tbl_created"}}}'
  exit 0
fi
echo '{"ok":true}'
`;
    writeFileSync(join(fakeBin, 'lark-cli'), fakeLark, { encoding: 'utf-8', mode: 0o755 });

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'provision-base',
        '--base-token',
        'base-secret-token',
        '--table-name',
        'RBrain Managed Assets',
        '--json',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(proc.stdout.toString()).not.toContain('base-secret-token');
    const payload = JSON.parse(proc.stdout.toString()) as {
      status: string;
      table_id: string | null;
      command: string[];
      fields: Array<{ name: string; type: string }>;
    };
    expect(payload.status).toBe('ok');
    expect(payload.table_id).toBe('tbl_created');
    expect(payload.command).toContain('<redacted>');
    expect(payload.fields).toContainEqual({ name: 'Source URI', type: 'text' });
    const log = readFileSync(logFile, 'utf-8');
    expect(log).toContain('+table-create');
    expect(log).toContain('RBrain\\ Managed\\ Assets');
  });

  test('managed sync mirrors registry rows into Base by Source URI', () => {
    const root = makeTempDir('rbrain-feishu-managed-base-');
    const fakeBin = makeTempDir('rbrain-feishu-managed-base-bin-');
    const logFile = join(fakeBin, 'calls.log');
    const dir = join(root, 'feishu', 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'roadmap.md'), '# Roadmap\n\nPlanning notes.\n', 'utf-8');

    const candidates = collectAilyPushCandidates(root);
    const seed = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'seed',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: candidates.map((candidate, idx) => ({
        source_uri: candidate.source_url,
        title: candidate.relative_path,
        content_sha256: candidate.content_sha256,
        normalized_text_uri: candidate.relative_path,
        aily_asset_title: candidate.title,
        aily_asset_id: `knowledge_asset_${idx}`,
        aily_status: 'successful',
        action: 'created',
      })),
    });
    saveManagedRegistry(defaultManagedRegistryPath(root), seed.snapshot);

    const fakeLark = `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "${logFile}"
printf '\\n' >> "${logFile}"
if [ "\${2:-}" = "+record-search" ]; then
  if printf '%s\\n' "$*" | grep -q 'rbrain-feishu-overview'; then
    echo '{"data":{"items":[{"record_id":"rec_existing"}]}}'
  else
    echo '{"data":{"items":[]}}'
  fi
  exit 0
fi
if [ "\${2:-}" = "+record-upsert" ]; then
  echo '{"ok":true}'
  exit 0
fi
echo '{"ok":true}'
`;
    writeFileSync(join(fakeBin, 'lark-cli'), fakeLark, { encoding: 'utf-8', mode: 0o755 });

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'sync',
        '--path',
        root,
        '--space-id',
        'knowledge_space_test',
        '--base-token',
        'base-secret-token',
        '--base-table-id',
        'tbl_test',
        '--json',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(proc.stdout.toString()).not.toContain('base-secret-token');
    const payload = JSON.parse(proc.stdout.toString()) as {
      base_mirror: { configured: boolean; created: number; updated: number; failed: number };
    };
    expect(payload.base_mirror.configured).toBe(true);
    expect(payload.base_mirror.created).toBe(1);
    expect(payload.base_mirror.updated).toBe(1);
    expect(payload.base_mirror.failed).toBe(0);
    const log = readFileSync(logFile, 'utf-8');
    expect(log).toContain('+record-search');
    expect(log).toContain('+record-upsert');
    expect(log).toContain('--record-id rec_existing');
  });

  test('expandPath resolves tilde paths', () => {
    expect(expandPath('~/rbrain-feishu')).toMatch(/\/rbrain-feishu$/);
  });

  test('auto-commit helper commits snapshots without making git mandatory', () => {
    const body = buildAutoCommitShellFunction();
    expect(body).toContain('command -v git');
    expect(body).toContain('git -C "$ROOT" add "$path"');
    expect(body).toContain('git -C "$ROOT" commit -m "$message"');
  });

  test('mirror script yaml_kv serializes shell values safely', () => {
    const script = `${buildAutoCommitShellFunction()}
{
  echo "---"
  yaml_kv query $'foo: bar\\nsecond line'
  echo "---"
}
`;
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(matter(result.stdout).data.query).toBe('foo: bar\nsecond line');
  });

  test('generated mirror scripts are valid bash', () => {
    const root = '/tmp/rbrain-feishu';
    const scripts: Array<[string, string]> = [
      ['agenda', buildAgendaScript(root)],
      ['doc', buildDocScript(root)],
      ['docs-list', buildDocListScript(root)],
      ['drive-search', buildDriveSearchScript(root)],
      ['wiki-spaces', buildWikiSpacesScript(root)],
      ['wiki-nodes', buildWikiNodesScript(root)],
      ['minutes-search', buildMinutesSearchScript(root)],
      ['mail-triage', buildMailTriageScript(root)],
      ['base-tables', buildBaseTablesScript(root)],
      ['base-fields', buildBaseFieldsScript(root)],
      ['base-records', buildBaseRecordsScript(root)],
      ['base-search', buildBaseSearchScript(root)],
      ['im-chat-list', buildImChatListScript(root)],
      ['im-chat-search', buildImChatSearchScript(root)],
      ['im-chat-messages', buildImChatMessagesScript(root)],
      ['im-message-search', buildImMessageSearchScript(root)],
      ['im-flags', buildImFlagsScript(root)],
      ['approval-tasks', buildApprovalTasksScript(root)],
      ['approval-initiated', buildApprovalInitiatedScript(root)],
      ['okr-cycles', buildOkrCyclesScript(root)],
      ['okr-cycle-detail', buildOkrCycleDetailScript(root)],
      ['tasks', buildTasksScript(root)],
      ['refresh', buildRefreshScript(root)],
    ];

    for (const [name, script] of scripts) {
      const result = spawnSync('bash', ['-n'], {
        input: script,
        encoding: 'utf-8',
      });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  test('direct pull markdown builders preserve Feishu schema types', () => {
    expect(buildAgendaMarkdown('2026-06-01', '{"items":[]}')).toContain('type: feishu-calendar');
    expect(buildDocMarkdown('review', 'https://example.feishu.cn/docx/x', '{"content":"ok"}')).toContain('type: feishu-doc');
    expect(buildDriveSearchMarkdown('20260601-090000', { query: 'roadmap', docTypes: 'docx,wiki' }, '{"items":[]}')).toContain('type: feishu-drive');
    expect(buildWikiSpacesMarkdown('20260601-090000', { pageAll: true }, '{"items":[]}')).toContain('wiki_scope: spaces');
    expect(buildWikiNodesMarkdown('20260601-090000', { spaceId: 'my_library' }, '{"items":[]}')).toContain('wiki_scope: nodes');
    expect(buildMinutesSearchMarkdown('20260601-090000', { query: '项目复盘' }, '{"items":[]}')).toContain('type: feishu-minutes');
    expect(buildMailTriageMarkdown('20260601-090000', { query: 'budget', max: '50' }, '{"items":[]}')).toContain('type: feishu-mail');
    expect(buildApprovalTasksMarkdown('20260601-090000', { pageAll: true }, '{"items":[]}')).toContain('approval_scope: tasks');
    expect(buildApprovalInitiatedMarkdown('20260601-090000', {}, '{"items":[]}')).toContain('approval_scope: initiated');
    expect(buildOkrCyclesMarkdown('20260601-090000', { timeRange: '2026-01--2026-06' }, '{"items":[]}')).toContain('okr_scope: cycles');
    expect(buildOkrCycleDetailMarkdown('20260601-090000', { cycleId: '123' }, '{"items":[]}')).toContain('okr_scope: cycle-detail');
    expect(buildBaseTablesMarkdown('20260601-090000', { baseToken: 'app-secret-token' }, '{"items":[]}')).toContain('base_scope: tables');
    expect(buildBaseTablesMarkdown('20260601-090000', { baseToken: 'app-secret-token' }, '{"items":[]}')).not.toContain('app-secret-token');
    expect(buildBaseFieldsMarkdown('20260601-090000', { baseToken: 'app-secret-token', tableId: 'tbl1' }, '{"items":[]}')).toContain('base_scope: fields');
    expect(buildBaseRecordsMarkdown('20260601-090000', { baseToken: 'app-secret-token', tableId: 'tbl1', fieldIds: ['Name'] }, '{"items":[]}')).toContain('base_scope: records');
    expect(buildBaseSearchMarkdown('20260601-090000', { baseToken: 'app-secret-token', tableId: 'tbl1', searchJson: '{"keyword":"Alice"}' }, '{"items":[]}')).toContain('base_scope: search');
    expect(buildImChatListMarkdown('20260601-090000', { types: 'group,p2p' }, '{"items":[]}')).toContain('im_scope: chat-list');
    expect(buildImChatSearchMarkdown('20260601-090000', { query: 'roadmap' }, '{"items":[]}')).toContain('im_scope: chat-search');
    expect(buildImChatMessagesMarkdown('20260601-090000', { chatId: 'oc_xxx' }, '{"items":[]}')).toContain('im_scope: chat-messages');
    expect(buildImMessageSearchMarkdown('20260601-090000', { query: 'pricing' }, '{"items":[]}')).toContain('im_scope: message-search');
    expect(buildImFlagsMarkdown('20260601-090000', { pageAll: true }, '{"items":[]}')).toContain('im_scope: flags');
    expect(buildTasksMarkdown('2026-06-01', { complete: false }, '{"items":[]}')).toContain('type: feishu-task');
  });

  test('direct pull markdown builders serialize user-controlled frontmatter safely', () => {
    const drive = matter(buildDriveSearchMarkdown(
      '20260601-090000',
      { query: 'foo: bar\nsecond line', docTypes: 'docx,wiki' },
      '{"items":[]}',
    ));
    expect(drive.data.query).toBe('foo: bar\nsecond line');
    expect(drive.data.doc_types).toBe('docx,wiki');

    const baseSearchJson = '{"keyword":"Alice: CEO","search_fields":["Name"]}';
    const base = matter(buildBaseSearchMarkdown(
      '20260601-090000',
      { tableId: 'tbl:one', searchJson: baseSearchJson },
      '{"items":[]}',
    ));
    expect(base.data.table_id).toBe('tbl:one');
    expect(base.data.search_json).toBe(baseSearchJson);

    const mail = matter(buildMailTriageMarkdown(
      '20260601-090000',
      { query: 'from: alice@example.com', filter: '{"from":["a:b@example.com"]}' },
      '{"items":[]}',
    ));
    expect(mail.data.query).toBe('from: alice@example.com');
    expect(mail.data.filter).toBe('{"from":["a:b@example.com"]}');
  });

  test('document manifest parser supports url-first and slug-first rows', () => {
    const parsed = parseDocManifest([
      '# docs',
      'https://example.feishu.cn/docx/abc product-review',
      'review-two\thttps://example.feishu.cn/docx/def',
      'doccnAbcdef123456 token-doc',
      '',
    ].join('\n'));
    expect(parsed).toEqual([
      { doc: 'https://example.feishu.cn/docx/abc', slug: 'product-review', line: 2 },
      { doc: 'https://example.feishu.cn/docx/def', slug: 'review-two', line: 3 },
      { doc: 'doccnAbcdef123456', slug: 'token-doc', line: 4 },
    ]);
  });

  test('document slugs are normalized before becoming mirror filenames', () => {
    expect(normalizeDocSlug('../Project Review.md')).toBe('Project-Review');
    expect(normalizeDocSlug('  项目 复盘  ')).toMatch(/^doc-[a-f0-9]{12}$/);
  });
});
