import { afterEach, describe, expect, test } from 'bun:test';
import matter from 'gray-matter';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { defaultManagedRegistryPath, recordManagedSyncResult, saveManagedRegistry, createEmptyManagedRegistry, loadManagedRegistry } from '../src/core/feishu-managed-registry.ts';
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
  buildManagedEnvCheck,
  buildManagedDeployBundleFiles,
  buildManagedDeployPlan,
  buildManagedTriggerProbeRequest,
  buildMirrorReadme,
  buildMirrorGitignore,
  buildManagedTriggerTemplate,
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
  createManagedRegistryStoreHandle,
  expandPath,
  handleManagedTriggerRequest,
  normalizeDocSlug,
  parseDocManifest,
  pushAilyKnowledgeSpace,
  resolveManagedRegistryStoreConfig,
  runManagedRegistryProvisionJob,
  runManagedRefreshStatusJob,
  runManagedSyncJob,
  runManagedTrigger,
  runManagedTriggerCanary,
  runManagedWaitStatusJob,
  sendManagedTriggerProbe,
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
    expect(stdout).toContain('--registry-store json|postgres');
    expect(stdout).toContain('--registry-url POSTGRES_URL');
    expect(stdout).toContain('RBRAIN_FEISHU_MANAGED_DATABASE_URL');
    expect(stdout).toContain('managed status [--path DIR]');
    expect(stdout).toContain('managed refresh-status [--path DIR]');
    expect(stdout).toContain('managed wait-status [--path DIR]');
    expect(stdout).toContain('managed base-template [--json]');
    expect(stdout).toContain('managed trigger-template [--json]');
    expect(stdout).toContain('managed deploy-bundle [--out DIR]');
    expect(stdout).toContain('managed deploy-plan [--url URL]');
    expect(stdout).toContain('managed env-check [--target status|canary|sync]');
    expect(stdout).toContain('managed probe [--action status|sync|refresh-status]');
    expect(stdout).toContain('managed canary --url URL');
    expect(stdout).toContain('[--wait-status]');
    expect(stdout).toContain('managed sql-schema [--json]');
    expect(stdout).toContain('managed provision-registry --registry-url POSTGRES_URL');
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
      registry_store: { kind: string; location: string };
      sync_run: { assets_seen: number; assets_changed: number; assets_uploaded: number };
      aily: { assets: Array<{ action: string; relative_path: string }> };
      base_mirror: { rows: number };
    };
    expect(payload.persisted).toBe(false);
    expect(payload.registry_path).toBe(join(root, '.rbrain-managed', 'registry.json'));
    expect(payload.registry_store).toEqual({
      kind: 'json',
      location: payload.registry_path,
    });
    expect(payload.sync_run.assets_seen).toBe(2);
    expect(payload.sync_run.assets_changed).toBe(2);
    expect(payload.sync_run.assets_uploaded).toBe(0);
    expect(payload.aily.assets.map((asset) => asset.action)).toEqual(['dry_run_create', 'dry_run_create']);
    expect(payload.aily.assets[0]!.relative_path).toBe('feishu/rbrain-feishu-overview.md');
    expect(payload.base_mirror.rows).toBe(2);
    expect(existsSync(payload.registry_path)).toBe(false);
  });

  test('managed sync job can run without the CLI dispatcher', async () => {
    const root = makeTempDir('rbrain-feishu-managed-job-');
    const dir = join(root, 'feishu', 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'roadmap.md'), '# Roadmap\n\nPlanning notes.\n', 'utf-8');

    const job = await runManagedSyncJob({
      root,
      env: {},
      opts: {
        path: root,
        sourceId: 'feishu',
        host: 'https://apaas.feishu.cn',
        knowledgeSpaceId: 'knowledge_space_test',
        tokenEnv: 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
        sourceUrlBase: 'https://rbrain.local/feishu-mirror',
        replace: false,
        dryRun: true,
        json: true,
        registryStore: 'json',
        registryEnsureSchema: false,
        trigger: 'manual',
        sourceKind: 'manual',
        sourceName: 'Feishu',
      },
    });

    expect(job.payload.status).toBe('ok');
    expect(job.payload.registry_store.kind).toBe('json');
    expect(job.payload.sync_run.assets_seen).toBe(2);
    expect(job.payload.aily.assets.map((asset) => asset.action)).toEqual(['dry_run_create', 'dry_run_create']);
    expect(job.tokenSource).toBe('(not needed)');
    expect(existsSync(defaultManagedRegistryPath(root))).toBe(false);
  });

  test('managed trigger can inspect registry status for a server function', async () => {
    const root = makeTempDir('rbrain-feishu-managed-trigger-status-');
    const seed = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'api',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: [{
        source_uri: 'feishu/docs/roadmap.md',
        title: 'feishu/docs/roadmap.md',
        content_sha256: 'f'.repeat(64),
        normalized_text_uri: 'feishu/docs/roadmap.md',
        aily_asset_title: 'rbrain-feishu-roadmap.txt',
        aily_asset_id: 'knowledge_asset_1',
        aily_status: 'successful',
        action: 'created',
      }],
    });
    saveManagedRegistry(defaultManagedRegistryPath(root), seed.snapshot);

    const result = await runManagedTrigger({
      request: {
        action: 'status',
        root,
      },
      env: {},
    });

    const statusPayload = result.result as {
      counts: { assets: number };
      latest_sync_run: { id: string } | null;
    };
    expect(result.action).toBe('status');
    expect(result.status).toBe('ok');
    expect(statusPayload.counts.assets).toBe(1);
    expect(statusPayload.latest_sync_run?.id).toBe(seed.sync_run.id);
  });

  test('managed trigger can run dry-run sync for a server function', async () => {
    const root = makeTempDir('rbrain-feishu-managed-trigger-sync-');
    const dir = join(root, 'feishu', 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'roadmap.md'), '# Roadmap\n\nPlanning notes.\n', 'utf-8');

    const result = await runManagedTrigger({
      request: {
        action: 'sync',
        root,
        trigger: 'api',
        aily: {
          knowledgeSpaceId: 'knowledge_space_test',
          dryRun: true,
        },
      },
      env: {},
    });

    const syncPayload = result.result as {
      sync_run: { trigger: string; assets_seen: number };
      aily: { assets: Array<{ action: string }> };
    };
    expect(result.action).toBe('sync');
    expect(result.status).toBe('ok');
    expect(syncPayload.sync_run.trigger).toBe('api');
    expect(syncPayload.sync_run.assets_seen).toBe(2);
    expect(syncPayload.aily.assets.map((asset) => asset.action)).toEqual(['dry_run_create', 'dry_run_create']);
    expect(existsSync(defaultManagedRegistryPath(root))).toBe(false);
  });

  test('managed trigger can refresh Aily status for a server function', async () => {
    const root = makeTempDir('rbrain-feishu-managed-trigger-refresh-status-');
    const seed = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'api',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: [{
        source_uri: 'feishu/docs/roadmap.md',
        title: 'feishu/docs/roadmap.md',
        content_sha256: 'f'.repeat(64),
        normalized_text_uri: 'feishu/docs/roadmap.md',
        aily_asset_title: 'rbrain-feishu-roadmap.txt',
        aily_asset_id: 'knowledge_asset_1',
        aily_status: 'learning',
        action: 'created',
      }],
    });
    saveManagedRegistry(defaultManagedRegistryPath(root), seed.snapshot);

    const result = await runManagedTrigger({
      request: {
        action: 'refresh-status',
        root,
        aily: {
          knowledgeSpaceId: 'knowledge_space_test',
        },
      },
      env: {
        RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN: 'aily-secret-token',
      },
      fetchImpl: async () => new Response(JSON.stringify({
        status_code: '0',
        data: {
          knowledge_assets: [{
            name: 'rbrain-feishu-roadmap.txt',
            knowledge_asset_id: 'knowledge_asset_1',
            status: 'successful',
          }],
          has_more: false,
        },
      })),
    });

    const refreshPayload = result.result as {
      checked: number;
      updated: number;
      assets: Array<{ previous_status: string | null; current_status: string | null }>;
    };
    expect(result.action).toBe('refresh-status');
    expect(result.status).toBe('ok');
    expect(refreshPayload.checked).toBe(1);
    expect(refreshPayload.updated).toBe(1);
    expect(refreshPayload.assets[0]).toMatchObject({
      previous_status: 'learning',
      current_status: 'successful',
    });
    expect(loadManagedRegistry(defaultManagedRegistryPath(root)).assets[0]!.aily_status).toBe('successful');
  });

  test('managed trigger can read mirror root and Base config from runtime env', async () => {
    const root = makeTempDir('rbrain-feishu-managed-trigger-env-');
    const dir = join(root, 'feishu', 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'roadmap.md'), '# Roadmap\n\nPlanning notes.\n', 'utf-8');

    let mirroredBaseToken = '';
    let mirroredBaseTableId = '';
    const result = await runManagedTrigger({
      request: {
        action: 'sync',
        aily: {
          knowledgeSpaceId: 'knowledge_space_test',
          dryRun: true,
        },
      },
      env: {
        RBRAIN_FEISHU_MIRROR_ROOT: root,
        RBRAIN_FEISHU_MANAGED_BASE_TOKEN: 'base-secret-token',
        RBRAIN_FEISHU_MANAGED_BASE_TABLE_ID: 'tbl_runtime',
      },
      mirrorBaseRows: (opts) => {
        mirroredBaseToken = opts.baseToken ?? '';
        mirroredBaseTableId = opts.tableId ?? '';
        return {
          status: 'ok',
          configured: true,
          dry_run: true,
          created: 0,
          updated: 0,
          failed: 0,
          errors: [],
        };
      },
    });

    expect(result.status).toBe('ok');
    expect(mirroredBaseToken).toBe('base-secret-token');
    expect(mirroredBaseTableId).toBe('tbl_runtime');
  });

  test('managed trigger HTTP handler runs dry-run sync from JSON body', async () => {
    const root = makeTempDir('rbrain-feishu-managed-http-sync-');
    const dir = join(root, 'feishu', 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'roadmap.md'), '# Roadmap\n\nPlanning notes.\n', 'utf-8');

    const response = await handleManagedTriggerRequest({
      request: {
        method: 'POST',
        body: JSON.stringify({
          action: 'sync',
          root,
          aily: {
            knowledgeSpaceId: 'knowledge_space_test',
            dryRun: true,
          },
        }),
      },
      env: {},
    });
    const payload = JSON.parse(response.body) as {
      action: string;
      status: string;
      result: { sync_run: { assets_seen: number } };
    };

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(payload.action).toBe('sync');
    expect(payload.status).toBe('ok');
    expect(payload.result.sync_run.assets_seen).toBe(2);
  });

  test('managed trigger HTTP handler rejects non-POST methods and redacts errors', async () => {
    const methodResponse = await handleManagedTriggerRequest({
      request: { method: 'GET' },
      env: {},
    });
    expect(methodResponse.status).toBe(405);
    expect(JSON.parse(methodResponse.body).error).toContain('GET');

    const pgUrl = 'postgresql://user:secret-password@example.com:5432/rbrain';
    const errorResponse = await handleManagedTriggerRequest({
      request: {
        method: 'POST',
        body: JSON.stringify({
          action: 'status',
          registry: {
            store: 'postgres',
            url: pgUrl,
          },
        }),
      },
      env: {},
      createStoreHandle: async () => {
        throw new Error(`cannot connect to ${pgUrl}`);
      },
    });

    expect(errorResponse.status).toBe(400);
    expect(errorResponse.body).not.toContain('secret-password');
    expect(errorResponse.body).not.toContain(pgUrl);
  });

  test('managed trigger template imports the public adapter without embedding secrets', () => {
    const template = buildManagedTriggerTemplate({
      importSpecifier: 'gbrain/feishu-managed',
    });

    expect(template).toContain('handleManagedTriggerRequest');
    expect(template).toContain('from "gbrain/feishu-managed"');
    expect(template).toContain('export default async function handler');
    expect(template).toContain('export async function scheduled');
    expect(template).toContain('export async function refreshStatus');
    expect(template).toContain("action: 'refresh-status'");
    expect(template).toContain('RBRAIN_FEISHU_MANAGED_DATABASE_URL');
    expect(template).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_ID');
    expect(template).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN');
    expect(template).not.toContain('secret-token');
    expect(template).not.toContain('postgresql://user:secret-password');
  });

  test('managed trigger-template prints a JSON deployment template', () => {
    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'trigger-template',
        '--json',
        '--import',
        'gbrain/feishu-managed',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      language: string;
      import_specifier: string;
      env: string[];
      template: string;
    };

    expect(payload.language).toBe('typescript');
    expect(payload.import_specifier).toBe('gbrain/feishu-managed');
    expect(payload.env).toContain('RBRAIN_FEISHU_MIRROR_ROOT');
    expect(payload.env).toContain('RBRAIN_FEISHU_MANAGED_DATABASE_URL');
    expect(payload.env).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_ID');
    expect(payload.env).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN');
    expect(payload.template).toContain('scheduled');
    expect(payload.template).toContain('status');
    expect(JSON.stringify(payload)).not.toContain('secret-token');
    expect(JSON.stringify(payload)).not.toContain('postgresql://user:secret-password');
  });

  test('managed deploy bundle files package trigger, schema, env, and README without real secrets', () => {
    const files = buildManagedDeployBundleFiles({
      importSpecifier: 'gbrain/feishu-managed',
    });
    const byPath = new Map(files.map((file) => [file.path, file.content]));

    expect(Array.from(byPath.keys()).sort()).toEqual([
      '.env.example',
      'README.md',
      'feishu-managed-local-server.ts',
      'feishu-managed-registry.sql',
      'feishu-managed-trigger.ts',
      'package.json',
    ]);
    expect(byPath.get('feishu-managed-trigger.ts')).toContain('from "gbrain/feishu-managed"');
    expect(byPath.get('feishu-managed-local-server.ts')).toContain("import handler from './feishu-managed-trigger.ts'");
    expect(byPath.get('feishu-managed-local-server.ts')).toContain('Bun.serve');
    expect(byPath.get('feishu-managed-registry.sql')).toContain('feishu_managed_assets');
    expect(JSON.parse(byPath.get('package.json') ?? '{}')).toMatchObject({
      name: 'rbrain-feishu-managed-runtime',
      private: true,
      type: 'module',
      scripts: {
        start: 'bun run feishu-managed-local-server.ts',
      },
      dependencies: {
        gbrain: 'github:Lostein/gbrain',
      },
    });
    expect(byPath.get('.env.example')).toContain('RBRAIN_FEISHU_MANAGED_DATABASE_URL=');
    expect(byPath.get('.env.example')).toContain('RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN=');
    expect(byPath.get('README.md')).toContain('status probe');
    expect(byPath.get('README.md')).toContain('managed deploy-plan');
    expect(byPath.get('README.md')).toContain('managed canary');
    expect(byPath.get('README.md')).toContain('bun run start');
    expect(byPath.get('README.md')).toContain('http://127.0.0.1:8787');
    expect(JSON.stringify(files)).not.toContain('secret-token');
    expect(JSON.stringify(files)).not.toContain('postgresql://user:secret-password');
  });

  test('managed deploy bundle can point package.json at a custom runtime package', () => {
    const files = buildManagedDeployBundleFiles({
      importSpecifier: '@example/rbrain-runtime/feishu-managed',
      packageDependency: 'npm:@example/rbrain-runtime@1.2.3',
    });
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    const manifest = JSON.parse(byPath.get('package.json') ?? '{}') as {
      dependencies?: Record<string, string>;
    };

    expect(byPath.get('feishu-managed-trigger.ts')).toContain('from "@example/rbrain-runtime/feishu-managed"');
    expect(manifest.dependencies).toEqual({
      '@example/rbrain-runtime': 'npm:@example/rbrain-runtime@1.2.3',
    });
  });

  test('managed deploy bundle rejects credential-bearing package dependencies', () => {
    expect(() => buildManagedDeployBundleFiles({
      packageDependency: 'git+https://token-secret@github.com/Lostein/gbrain.git',
    })).toThrow('--dependency must not include credentials or tokens');
  });

  test('managed deploy-bundle writes deployable files and reports them as JSON', () => {
    const root = makeTempDir('rbrain-feishu-managed-deploy-');
    const outDir = join(root, 'bundle');
    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'deploy-bundle',
        '--out',
        outDir,
        '--json',
        '--import',
        'gbrain/feishu-managed',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      status: string;
      out_dir: string;
      import_specifier: string;
      package_dependency: string;
      files: Array<{ path: string; bytes: number }>;
      env: string[];
    };

    expect(payload.status).toBe('ok');
    expect(payload.out_dir).toBe(outDir);
    expect(payload.import_specifier).toBe('gbrain/feishu-managed');
    expect(payload.package_dependency).toBe('github:Lostein/gbrain');
    expect(payload.files.map((file) => file.path).sort()).toEqual([
      '.env.example',
      'README.md',
      'feishu-managed-local-server.ts',
      'feishu-managed-registry.sql',
      'feishu-managed-trigger.ts',
      'package.json',
    ]);
    expect(payload.env).toContain('RBRAIN_FEISHU_MANAGED_DATABASE_URL');
    expect(existsSync(join(outDir, 'feishu-managed-trigger.ts'))).toBe(true);
    expect(readFileSync(join(outDir, 'feishu-managed-local-server.ts'), 'utf-8')).toContain('Bun.serve');
    expect(readFileSync(join(outDir, 'feishu-managed-trigger.ts'), 'utf-8')).toContain('handleManagedTriggerRequest');
    expect(readFileSync(join(outDir, 'feishu-managed-registry.sql'), 'utf-8')).toContain('feishu_managed_sync_runs');
    expect(readFileSync(join(outDir, 'package.json'), 'utf-8')).toContain('github:Lostein/gbrain');
    expect(readFileSync(join(outDir, '.env.example'), 'utf-8')).not.toContain('postgresql://');
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  test('managed deploy-bundle refuses to overwrite existing files without --force', () => {
    const root = makeTempDir('rbrain-feishu-managed-deploy-conflict-');
    const outDir = join(root, 'bundle');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'README.md'), 'existing\n', 'utf-8');

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'deploy-bundle',
        '--out',
        outDir,
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain('refuses to overwrite existing files');
    expect(readFileSync(join(outDir, 'README.md'), 'utf-8')).toBe('existing\n');
  });

  test('managed deploy plan orders online verification without leaking secrets', () => {
    const plan = buildManagedDeployPlan({
      url: 'https://runtime.example/trigger',
      targetStatus: 'successful',
      timeoutMs: 1_000,
      intervalMs: 500,
      env: {
        RBRAIN_FEISHU_MANAGED_DATABASE_URL: 'postgresql://user:secret-password@example.com:5432/rbrain',
        RBRAIN_FEISHU_MIRROR_ROOT: '/tmp/rbrain-feishu',
        RBRAIN_AILY_KNOWLEDGE_SPACE_ID: 'knowledge_space_test',
        RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN: 'secret-token',
      },
    });

    expect(plan.status).toBe('ready');
    expect(plan.env_check.status).toBe('ok');
    expect(plan.missing_required_env_keys).toEqual([]);
    expect(plan.steps.map((step) => step.id)).toEqual([
      'env-check',
      'provision-registry',
      'deploy-trigger',
      'status-canary',
      'production-canary',
      'inspect-registry',
      'agent-answer-check',
    ]);
    expect(plan.steps.find((step) => step.id === 'production-canary')?.command).toContain('--wait-status');
    expect(plan.steps.find((step) => step.id === 'production-canary')?.command).toContain('--timeout-ms 1000');
    expect(JSON.stringify(plan)).not.toContain('secret-password');
    expect(JSON.stringify(plan)).not.toContain('secret-token');
    expect(JSON.stringify(plan)).not.toContain('/tmp/rbrain-feishu');
  });

  test('managed deploy plan blocks when env or trigger URL is missing', () => {
    const plan = buildManagedDeployPlan({ env: {} });

    expect(plan.status).toBe('blocked');
    expect(plan.missing_required_env_keys).toEqual([
      'RBRAIN_FEISHU_MANAGED_DATABASE_URL',
      'RBRAIN_FEISHU_MIRROR_ROOT',
      'RBRAIN_AILY_KNOWLEDGE_SPACE_ID',
      'AILY_KNOWLEDGE_SPACE_ID',
      'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
      'AILY_KNOWLEDGE_SPACE_API_TOKEN',
    ]);
    expect(plan.steps.find((step) => step.id === 'env-check')).toMatchObject({
      status: 'blocked',
    });
    expect(plan.steps.find((step) => step.id === 'status-canary')).toMatchObject({
      status: 'blocked',
    });
  });

  test('managed deploy-plan CLI reads env-file and returns JSON status', () => {
    const root = makeTempDir('rbrain-feishu-deploy-plan-');
    const envFile = join(root, '.env');
    writeFileSync(envFile, [
      'RBRAIN_FEISHU_MANAGED_DATABASE_URL=postgresql://user:secret-password@example.com:5432/rbrain',
      'RBRAIN_FEISHU_MIRROR_ROOT=/tmp/rbrain-feishu',
      'RBRAIN_AILY_KNOWLEDGE_SPACE_ID=knowledge_space_test',
      'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN=secret-token',
      '',
    ].join('\n'), 'utf-8');

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'deploy-plan',
        '--env-file',
        envFile,
        '--url',
        'https://runtime.example/trigger',
        '--json',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
      },
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      status: string;
      trigger_url: string | null;
      steps: Array<{ id: string; status: string; command?: string }>;
    };

    expect(payload.status).toBe('ready');
    expect(payload.trigger_url).toBe('https://runtime.example/trigger');
    expect(payload.steps.find((step) => step.id === 'production-canary')?.command).toContain('--wait-status');
    expect(proc.stdout.toString()).not.toContain('secret-password');
    expect(proc.stdout.toString()).not.toContain('secret-token');
    expect(proc.stdout.toString()).not.toContain('/tmp/rbrain-feishu');
  });

  test('managed env check reports missing required runtime variables without leaking values', () => {
    const result = buildManagedEnvCheck({
      target: 'sync',
      env: {
        RBRAIN_FEISHU_MANAGED_DATABASE_URL: 'postgresql://user:secret-password@example.com:5432/rbrain',
        RBRAIN_FEISHU_MIRROR_ROOT: '/tmp/rbrain-feishu',
        RBRAIN_AILY_KNOWLEDGE_SPACE_ID: 'knowledge_space_test',
        RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN: 'secret-token',
      },
    });

    expect(result.status).toBe('ok');
    expect(result.checks.find((check) => check.id === 'serverless_pg')?.present).toEqual(['RBRAIN_FEISHU_MANAGED_DATABASE_URL']);
    expect(JSON.stringify(result)).not.toContain('secret-password');
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('/tmp/rbrain-feishu');
  });

  test('managed env check requires Aily token for canary refresh-status coverage', () => {
    const canary = buildManagedEnvCheck({
      target: 'canary',
      env: {
        RBRAIN_FEISHU_MANAGED_DATABASE_URL: 'postgresql://host/db',
        RBRAIN_FEISHU_MIRROR_ROOT: '/tmp/rbrain-feishu',
        RBRAIN_AILY_KNOWLEDGE_SPACE_ID: 'knowledge_space_test',
      },
    });
    const sync = buildManagedEnvCheck({
      target: 'sync',
      env: {
        RBRAIN_FEISHU_MANAGED_DATABASE_URL: 'postgresql://host/db',
        RBRAIN_FEISHU_MIRROR_ROOT: '/tmp/rbrain-feishu',
        RBRAIN_AILY_KNOWLEDGE_SPACE_ID: 'knowledge_space_test',
      },
    });

    expect(canary.status).toBe('fail');
    expect(canary.checks.find((check) => check.id === 'aily_token')).toMatchObject({
      status: 'missing',
      required: true,
    });
    expect(sync.status).toBe('fail');
    expect(sync.checks.find((check) => check.id === 'aily_token')).toMatchObject({
      status: 'missing',
      required: true,
    });
  });

  test('managed env check warns when optional Base status mirror is incomplete', () => {
    const result = buildManagedEnvCheck({
      target: 'status',
      env: {
        RBRAIN_FEISHU_MANAGED_DATABASE_URL: 'postgresql://host/db',
        RBRAIN_FEISHU_MANAGED_BASE_TOKEN: 'base-secret-token',
      },
    });

    expect(result.status).toBe('warn');
    expect(result.checks.find((check) => check.id === 'base_status_table')).toMatchObject({
      status: 'warn',
      required: false,
      present: ['RBRAIN_FEISHU_MANAGED_BASE_TOKEN'],
    });
    expect(JSON.stringify(result)).not.toContain('base-secret-token');
  });

  test('managed env-check CLI reads env-file and returns JSON status', () => {
    const root = makeTempDir('rbrain-feishu-env-check-');
    const envFile = join(root, '.env');
    writeFileSync(envFile, [
      'RBRAIN_FEISHU_MANAGED_DATABASE_URL=postgresql://user:secret-password@example.com:5432/rbrain',
      'RBRAIN_FEISHU_MIRROR_ROOT=/tmp/rbrain-feishu',
      'RBRAIN_AILY_KNOWLEDGE_SPACE_ID=knowledge_space_test',
      'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN=secret-token',
      '',
    ].join('\n'), 'utf-8');

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'env-check',
        '--target',
        'canary',
        '--env-file',
        envFile,
        '--json',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
      },
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      status: string;
      target: string;
      checks: Array<{ id: string; status: string; present: string[] }>;
    };

    expect(payload.status).toBe('ok');
    expect(payload.target).toBe('canary');
    expect(payload.checks.find((check) => check.id === 'serverless_pg')?.status).toBe('ok');
    expect(proc.stdout.toString()).not.toContain('secret-password');
    expect(proc.stdout.toString()).not.toContain('secret-token');
    expect(proc.stdout.toString()).not.toContain('/tmp/rbrain-feishu');
  });

  test('managed probe builds safe status and dry-run sync requests', () => {
    const statusProbe = buildManagedTriggerProbeRequest({ action: 'status' });
    expect(statusProbe).toEqual({
      action: 'status',
      registry: {
        store: 'postgres',
        ensureSchema: true,
      },
    });

    const syncProbe = buildManagedTriggerProbeRequest({
      action: 'sync',
      root: '/tmp/rbrain-feishu',
      sourceId: 'feishu',
    });
    expect(syncProbe).toEqual({
      action: 'sync',
      sourceId: 'feishu',
      root: '/tmp/rbrain-feishu',
      trigger: 'probe',
      registry: {
        store: 'postgres',
        ensureSchema: true,
      },
      aily: {
        dryRun: true,
      },
    });
    expect(JSON.stringify(syncProbe)).not.toContain('secret-token');
    expect(JSON.stringify(syncProbe)).not.toContain('postgresql://');

    const refreshProbe = buildManagedTriggerProbeRequest({
      action: 'refresh-status',
      sourceId: 'feishu',
    });
    expect(refreshProbe).toEqual({
      action: 'refresh-status',
      sourceId: 'feishu',
      registry: {
        store: 'postgres',
        ensureSchema: true,
      },
      aily: {
        dryRun: true,
      },
    });
  });

  test('managed probe can POST a request with JSON headers', async () => {
    const request = buildManagedTriggerProbeRequest({ action: 'status' });
    let postedUrl = '';
    let postedBody = '';
    let postedContentType = '';
    const result = await sendManagedTriggerProbe({
      url: 'https://runtime.example/trigger',
      request,
      fetchImpl: async (url, init) => {
        postedUrl = String(url);
        postedBody = String(init?.body ?? '');
        postedContentType = String((init?.headers as Record<string, string>)['content-type'] ?? '');
        return new Response(JSON.stringify({ action: 'status', status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(postedUrl).toBe('https://runtime.example/trigger');
    expect(postedContentType).toBe('application/json');
    expect(JSON.parse(postedBody)).toEqual(request);
    expect(result.status).toBe('ok');
    expect(result.response.status).toBe(200);
    expect(result.response.json).toEqual({ action: 'status', status: 'ok' });
  });

  test('managed probe redacts Postgres URLs from remote response bodies', async () => {
    const pgUrl = 'postgresql://user:secret-password@example.com:5432/rbrain';
    const result = await sendManagedTriggerProbe({
      url: 'https://runtime.example/trigger',
      request: buildManagedTriggerProbeRequest({ action: 'status' }),
      fetchImpl: async () => new Response(`cannot connect to ${pgUrl}`, { status: 500 }),
    });

    expect(result.status).toBe('error');
    expect(result.response.body).not.toContain('secret-password');
    expect(result.response.body).not.toContain(pgUrl);
  });

  test('managed canary runs status, dry-run sync, then refresh-status', async () => {
    const calls: Array<{ action?: string; body: Record<string, unknown> }> = [];
    const result = await runManagedTriggerCanary({
      url: 'https://runtime.example/trigger',
      root: '/tmp/rbrain-feishu',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ action: String(body.action), body });
        return new Response(JSON.stringify({ action: body.action, status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.status).toBe('ok');
    expect(result.dry_run).toBe(true);
    expect(calls.map((call) => call.action)).toEqual(['status', 'sync', 'refresh-status']);
    expect((calls[1]!.body.aily as Record<string, unknown>).dryRun).toBe(true);
    expect((calls[2]!.body.aily as Record<string, unknown>).dryRun).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok']);
  });

  test('managed canary can wait for refresh-status target state', async () => {
    const calls: string[] = [];
    let refreshCalls = 0;
    let currentMs = 0;
    const result = await runManagedTriggerCanary({
      url: 'https://runtime.example/trigger',
      root: '/tmp/rbrain-feishu',
      waitStatus: true,
      targetStatus: 'successful',
      timeoutMs: 3_000,
      intervalMs: 1_000,
      now: () => currentMs,
      sleep: async (ms) => {
        currentMs += ms;
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push(String(body.action));
        if (body.action === 'refresh-status') {
          refreshCalls++;
          const currentStatus = refreshCalls === 1 ? 'learning' : 'successful';
          return new Response(JSON.stringify({
            action: 'refresh-status',
            status: 'ok',
            result: {
              checked: 1,
              matched: 1,
              missing: 0,
              assets: [{ asset_id: 'asset_1', current_status: currentStatus }],
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ action: body.action, status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.status).toBe('ok');
    expect(calls).toEqual(['status', 'sync', 'refresh-status', 'refresh-status']);
    expect(result.steps.map((step) => step.name)).toEqual(['status', 'sync', 'refresh-status', 'wait-status']);
    expect(result.steps[3]).toMatchObject({
      name: 'wait-status',
      status: 'ok',
      reason: 'target successful reached after 2 refresh attempts',
    });
    expect(result.steps[3]!.response?.json).toEqual({
      action: 'refresh-status',
      status: 'ok',
      result: {
        checked: 1,
        matched: 1,
        missing: 0,
        assets: [{ asset_id: 'asset_1', current_status: 'successful' }],
      },
    });
  });

  test('managed canary reports wait-status timeout with the latest refresh response', async () => {
    const calls: string[] = [];
    let currentMs = 0;
    const result = await runManagedTriggerCanary({
      url: 'https://runtime.example/trigger',
      root: '/tmp/rbrain-feishu',
      waitStatus: true,
      targetStatus: 'successful',
      timeoutMs: 1_000,
      intervalMs: 500,
      now: () => currentMs,
      sleep: async (ms) => {
        currentMs += ms;
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push(String(body.action));
        if (body.action === 'refresh-status') {
          return new Response(JSON.stringify({
            action: 'refresh-status',
            status: 'ok',
            result: {
              checked: 1,
              matched: 1,
              missing: 0,
              assets: [{ asset_id: 'asset_1', current_status: 'learning' }],
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ action: body.action, status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.status).toBe('error');
    expect(calls).toEqual(['status', 'sync', 'refresh-status', 'refresh-status', 'refresh-status']);
    expect(result.steps.map((step) => step.name)).toEqual(['status', 'sync', 'refresh-status', 'wait-status']);
    expect(result.steps[3]).toMatchObject({
      name: 'wait-status',
      status: 'error',
      reason: 'target successful not reached after 3 refresh attempts',
    });
    expect(result.steps[3]!.response?.json).toEqual({
      action: 'refresh-status',
      status: 'ok',
      result: {
        checked: 1,
        matched: 1,
        missing: 0,
        assets: [{ asset_id: 'asset_1', current_status: 'learning' }],
      },
    });
  });

  test('managed canary skips sync when status fails', async () => {
    const calls: string[] = [];
    const result = await runManagedTriggerCanary({
      url: 'https://runtime.example/trigger',
      root: '/tmp/rbrain-feishu',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push(String(body.action));
        return new Response(JSON.stringify({ status: 'error' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.status).toBe('error');
    expect(calls).toEqual(['status']);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.status).toBe('error');
    expect(result.steps[1]).toMatchObject({
      name: 'sync',
      status: 'skipped',
      reason: 'status probe failed',
    });
  });

  test('managed canary skips refresh-status when sync fails', async () => {
    const calls: string[] = [];
    const result = await runManagedTriggerCanary({
      url: 'https://runtime.example/trigger',
      root: '/tmp/rbrain-feishu',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push(String(body.action));
        return new Response(JSON.stringify({ status: body.action === 'sync' ? 'error' : 'ok' }), {
          status: body.action === 'sync' ? 503 : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.status).toBe('error');
    expect(calls).toEqual(['status', 'sync']);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[2]).toMatchObject({
      name: 'refresh-status',
      status: 'skipped',
      reason: 'sync probe failed',
    });
  });

  test('managed probe CLI previews a dry-run sync request', () => {
    const root = makeTempDir('rbrain-feishu-probe-preview-');
    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'probe',
        '--action',
        'sync',
        '--root',
        root,
        '--json',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      status: string;
      request: {
        action: string;
        root: string;
        registry: { store: string; ensureSchema: boolean };
        aily: { dryRun: boolean };
      };
    };

    expect(payload.status).toBe('preview');
    expect(payload.request.action).toBe('sync');
    expect(payload.request.root).toBe(root);
    expect(payload.request.registry).toEqual({ store: 'postgres', ensureSchema: true });
    expect(payload.request.aily.dryRun).toBe(true);
    expect(proc.stdout.toString()).not.toContain('secret-token');
    expect(proc.stdout.toString()).not.toContain('postgresql://');
  });

  test('managed registry store config defaults to JSON and redacts Postgres URLs', async () => {
    const root = makeTempDir('rbrain-feishu-managed-store-');
    const jsonConfig = resolveManagedRegistryStoreConfig({
      kind: 'json',
      root,
      ensureSchema: true,
    });
    expect(jsonConfig).toEqual({
      kind: 'json',
      registryPath: join(root, '.rbrain-managed', 'registry.json'),
      location: join(root, '.rbrain-managed', 'registry.json'),
      ensureSchema: false,
    });

    const pgUrl = 'postgresql://user:secret-password@example.com:5432/rbrain';
    const pgConfig = resolveManagedRegistryStoreConfig({
      kind: 'postgres',
      root,
      registryUrl: pgUrl,
      ensureSchema: true,
    });
    expect(pgConfig.location).toBe('postgresql://***@example.com:5432/rbrain');
    expect(pgConfig.location).not.toContain('secret-password');

    let createdWithUrl = '';
    let closed = false;
    const fakeSql = (async () => []) as any;
    fakeSql.unsafe = async () => [];
    fakeSql.end = async () => { closed = true; };
    fakeSql.json = (value: unknown) => ({ json: value });
    const handle = await createManagedRegistryStoreHandle(pgConfig, (url) => {
      createdWithUrl = url;
      return fakeSql;
    });

    expect(createdWithUrl).toBe(pgUrl);
    expect(handle.store.kind).toBe('postgres');
    expect(handle.store.location).toBe(pgConfig.location);
    await handle.close?.();
    expect(closed).toBe(true);
  });

  test('managed provision-registry job applies Postgres schema and reports counts with a redacted URL', async () => {
    let capturedEnsureSchema = false;
    let closed = false;
    const payload = await runManagedRegistryProvisionJob({
      root: process.cwd(),
      opts: {
        sourceId: 'feishu',
        registryStore: 'postgres',
        registryUrl: 'postgresql://user:secret-password@example.com:5432/rbrain',
        registryEnsureSchema: true,
        json: true,
      },
      createStoreHandle: async (config) => {
        capturedEnsureSchema = config.ensureSchema;
        return {
          store: {
            kind: 'postgres',
            location: config.location,
            load: async () => createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'),
            save: async () => {},
          },
          close: async () => {
            closed = true;
          },
        };
      },
    });

    expect(capturedEnsureSchema).toBe(true);
    expect(closed).toBe(true);
    expect(payload.status).toBe('ok');
    expect(payload.schema).toMatchObject({
      dialect: 'postgres',
      ensured: true,
      tables: ['feishu_managed_sources', 'feishu_managed_assets', 'feishu_managed_sync_runs'],
    });
    expect(payload.counts).toMatchObject({ sources: 0, assets: 0, sync_runs: 0 });
    expect(payload.registry_store.location).toContain('***');
    expect(payload.registry_store.location).not.toContain('secret-password');
  });

  test('managed status summarizes a local registry without Aily credentials', () => {
    const root = makeTempDir('rbrain-feishu-managed-status-');
    const candidates = collectAilyPushCandidates(root);
    const seed = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'manual',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: candidates.map((candidate, idx) => ({
        source_uri: candidate.source_url,
        title: candidate.relative_path,
        content_sha256: candidate.content_sha256,
        normalized_text_uri: candidate.relative_path,
        aily_asset_title: candidate.title,
        aily_asset_id: `knowledge_asset_${idx}`,
        aily_status: idx === 0 ? 'successful' : 'learning',
        action: 'created',
      })),
    });
    saveManagedRegistry(defaultManagedRegistryPath(root), seed.snapshot);

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        'run',
        'src/rbrain.ts',
        'feishu',
        'managed',
        'status',
        '--path',
        root,
        '--json',
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      status: string;
      registry_store: { kind: string; location: string };
      counts: { sources: number; assets: number; sync_runs: number; base_mirror_rows: number };
      latest_sync_run: { id: string; assets_seen: number };
      aily_statuses: Record<string, number>;
      base_mirror: { preview: unknown[] };
    };

    expect(payload.status).toBe('ok');
    expect(payload.registry_store.kind).toBe('json');
    expect(payload.registry_store.location).toBe(defaultManagedRegistryPath(root));
    expect(payload.counts).toEqual({
      sources: 1,
      assets: 1,
      sync_runs: 1,
      base_mirror_rows: 1,
    });
    expect(payload.latest_sync_run.id).toBe(seed.sync_run.id);
    expect(payload.latest_sync_run.assets_seen).toBe(1);
    expect(payload.aily_statuses).toEqual({ successful: 1 });
    expect(payload.base_mirror.preview).toHaveLength(1);
  });

  test('managed refresh-status job re-reads Aily statuses without leaking the token', async () => {
    const root = makeTempDir('rbrain-feishu-managed-refresh-status-');
    const candidates = collectAilyPushCandidates(root);
    const seed = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'manual',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: candidates.map((candidate, idx) => ({
        source_uri: candidate.source_url,
        title: candidate.relative_path,
        content_sha256: candidate.content_sha256,
        normalized_text_uri: candidate.relative_path,
        aily_asset_title: candidate.title,
        aily_asset_id: `knowledge_asset_${idx}`,
        aily_status: 'learning',
        action: 'created',
      })),
    });
    saveManagedRegistry(defaultManagedRegistryPath(root), seed.snapshot);

    let mirroredStatus = '';
    const job = await runManagedRefreshStatusJob({
      root,
      env: { RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN: 'aily-secret-token' },
      opts: {
        path: root,
        sourceId: 'feishu',
        host: 'https://apaas.feishu.cn',
        knowledgeSpaceId: 'knowledge_space_test',
        tokenEnv: 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
        dryRun: false,
        json: true,
        registryStore: 'json',
        registryEnsureSchema: false,
        baseToken: 'base-secret-token',
        baseTableId: 'tbl_test',
      },
      fetchImpl: async (_url, init) => {
        if (!init) throw new Error('expected Aily list request init');
        expect(init.headers).toMatchObject({ 'x-api-token': 'aily-secret-token' });
        return new Response(JSON.stringify({
          status_code: '0',
          data: {
            knowledge_assets: [
              { name: candidates[0]!.title, knowledge_asset_id: 'knowledge_asset_0', status: 'successful' },
            ],
            has_more: false,
            total: 1,
          },
        }));
      },
      mirrorBaseRows: ({ rows }) => {
        mirroredStatus = rows[0]?.aily_status ?? '';
        return {
          status: 'ok',
          configured: true,
          dry_run: false,
          created: 0,
          updated: rows.length,
          failed: 0,
          errors: [],
        };
      },
    });

    expect(job.payload.status).toBe('ok');
    expect(job.payload.persisted).toBe(true);
    expect(job.payload.checked).toBe(1);
    expect(job.payload.updated).toBe(1);
    expect(job.payload.assets[0]!.previous_status).toBe('learning');
    expect(job.payload.assets[0]!.current_status).toBe('successful');
    expect(job.payload.base_mirror.configured).toBe(true);
    expect(mirroredStatus).toBe('successful');
    expect(JSON.stringify(job.payload)).not.toContain('aily-secret-token');
    expect(JSON.stringify(job.payload)).not.toContain('base-secret-token');

    const saved = loadManagedRegistry(defaultManagedRegistryPath(root));
    expect(saved.assets[0]!.aily_status).toBe('successful');
    expect(saved.assets[0]!.last_synced_at).toBe('2026-06-07T10:00:01.000Z');
  });

  test('managed wait-status job polls until Aily assets reach the target status', async () => {
    const root = makeTempDir('rbrain-feishu-managed-wait-status-');
    const candidates = collectAilyPushCandidates(root);
    const seed = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'manual',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: candidates.map((candidate, idx) => ({
        source_uri: candidate.source_url,
        title: candidate.relative_path,
        content_sha256: candidate.content_sha256,
        normalized_text_uri: candidate.relative_path,
        aily_asset_title: candidate.title,
        aily_asset_id: `knowledge_asset_${idx}`,
        aily_status: 'learning',
        action: 'created',
      })),
    });
    saveManagedRegistry(defaultManagedRegistryPath(root), seed.snapshot);

    let currentMs = 0;
    let calls = 0;
    const payload = await runManagedWaitStatusJob({
      root,
      env: { RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN: 'aily-secret-token' },
      opts: {
        path: root,
        sourceId: 'feishu',
        host: 'https://apaas.feishu.cn',
        knowledgeSpaceId: 'knowledge_space_test',
        tokenEnv: 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
        dryRun: false,
        json: true,
        registryStore: 'json',
        registryEnsureSchema: false,
        targetStatus: 'successful',
        timeoutMs: 3_000,
        intervalMs: 1_000,
      },
      now: () => currentMs,
      sleep: async (ms) => {
        currentMs += ms;
      },
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({
          status_code: '0',
          data: {
            knowledge_assets: [{
              name: candidates[0]!.title,
              knowledge_asset_id: 'knowledge_asset_0',
              status: calls === 1 ? 'learning' : 'successful',
            }],
            has_more: false,
          },
        }));
      },
    });

    expect(payload.status).toBe('ok');
    expect(payload.attempts).toBe(2);
    expect(payload.elapsed_ms).toBe(1_000);
    expect(payload.final.assets[0]!.current_status).toBe('successful');
    expect(loadManagedRegistry(defaultManagedRegistryPath(root)).assets[0]!.aily_status).toBe('successful');
  });

  test('managed wait-status job times out with the last observed Aily status', async () => {
    const root = makeTempDir('rbrain-feishu-managed-wait-timeout-');
    const candidates = collectAilyPushCandidates(root);
    const seed = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'manual',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: candidates.map((candidate, idx) => ({
        source_uri: candidate.source_url,
        title: candidate.relative_path,
        content_sha256: candidate.content_sha256,
        normalized_text_uri: candidate.relative_path,
        aily_asset_title: candidate.title,
        aily_asset_id: `knowledge_asset_${idx}`,
        aily_status: 'learning',
        action: 'created',
      })),
    });
    saveManagedRegistry(defaultManagedRegistryPath(root), seed.snapshot);

    let currentMs = 0;
    const payload = await runManagedWaitStatusJob({
      root,
      env: { RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN: 'aily-secret-token' },
      opts: {
        path: root,
        sourceId: 'feishu',
        host: 'https://apaas.feishu.cn',
        knowledgeSpaceId: 'knowledge_space_test',
        tokenEnv: 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
        dryRun: true,
        json: true,
        registryStore: 'json',
        registryEnsureSchema: false,
        targetStatus: 'successful',
        timeoutMs: 1_000,
        intervalMs: 500,
      },
      now: () => currentMs,
      sleep: async (ms) => {
        currentMs += ms;
      },
      fetchImpl: async () => new Response(JSON.stringify({
        status_code: '0',
        data: {
          knowledge_assets: [{
            name: candidates[0]!.title,
            knowledge_asset_id: 'knowledge_asset_0',
            status: 'learning',
          }],
          has_more: false,
        },
      })),
    });

    expect(payload.status).toBe('timeout');
    expect(payload.attempts).toBe(3);
    expect(payload.elapsed_ms).toBe(1_000);
    expect(payload.final.assets[0]!.current_status).toBe('learning');
    expect(loadManagedRegistry(defaultManagedRegistryPath(root)).assets[0]!.aily_status).toBe('learning');
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

  test('managed sql-schema prints Postgres DDL for the registry tables', () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/rbrain.ts', 'feishu', 'managed', 'sql-schema', '--json'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const payload = JSON.parse(proc.stdout.toString()) as {
      schema_version: number;
      dialect: string;
      sql: string;
    };
    expect(payload.schema_version).toBe(1);
    expect(payload.dialect).toBe('postgres');
    expect(payload.sql).toContain('feishu_managed_sources');
    expect(payload.sql).toContain('feishu_managed_assets');
    expect(payload.sql).toContain('feishu_managed_sync_runs');
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
