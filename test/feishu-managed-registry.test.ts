import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEISHU_MANAGED_SQL_SCHEMA_VERSION,
  MANAGED_BASE_FIELD_NAMES,
  buildManagedBaseRecordFields,
  buildManagedBaseTableFieldsJson,
  buildManagedRegistrySqlSchema,
  buildManagedBaseMirrorRows,
  createEmptyManagedRegistry,
  createJsonManagedRegistryStore,
  createPostgresManagedRegistryStore,
  recordManagedSyncResult,
  type ManagedRegistrySqlClient,
} from '../src/core/feishu-managed-registry.ts';

function makeFakeManagedSql(
  rows: {
    sources?: Array<Record<string, unknown>>;
    assets?: Array<Record<string, unknown>>;
    syncRuns?: Array<Record<string, unknown>>;
  } = {},
): ManagedRegistrySqlClient & { calls: string[]; values: unknown[][]; unsafeCalls: string[] } {
  const calls: string[] = [];
  const values: unknown[][] = [];
  const unsafeCalls: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...queryValues: unknown[]) => {
    const text = strings.join('?');
    calls.push(text);
    values.push(queryValues);
    if (text.includes('FROM feishu_managed_sources')) return rows.sources ?? [];
    if (text.includes('FROM feishu_managed_assets')) return rows.assets ?? [];
    if (text.includes('FROM feishu_managed_sync_runs')) return rows.syncRuns ?? [];
    return [];
  }) as ManagedRegistrySqlClient & { calls: string[]; values: unknown[][]; unsafeCalls: string[] };
  sql.calls = calls;
  sql.values = values;
  sql.unsafeCalls = unsafeCalls;
  sql.unsafe = async (query: string) => {
    unsafeCalls.push(query);
    return [];
  };
  sql.begin = async (fn) => fn(sql);
  sql.json = (value: unknown) => ({ json: value });
  return sql;
}

describe('Feishu managed registry', () => {
  test('records sources, assets, sync runs, and redacts secrets', () => {
    const startedAt = '2026-06-07T10:00:00.000Z';
    const finishedAt = '2026-06-07T10:00:03.000Z';
    const result = recordManagedSyncResult(createEmptyManagedRegistry(startedAt), {
      source: {
        id: 'feishu',
        kind: 'manual',
        name: 'Feishu',
        config_json: {
          mirror_path: '/tmp/rbrain-feishu',
          api_token: 'secret-token',
          nested: { app_secret: 'secret-value' },
        },
      },
      trigger: 'manual',
      started_at: startedAt,
      finished_at: finishedAt,
      assets: [{
        source_uri: 'https://example.feishu.cn/docx/abc',
        title: 'feishu/docs/roadmap.md',
        content_sha256: 'a'.repeat(64),
        normalized_text_uri: 'feishu/docs/roadmap.md',
        aily_asset_title: 'rbrain-feishu-roadmap.txt',
        aily_asset_id: 'knowledge_asset_1',
        aily_status: 'learning',
        action: 'created',
      }],
    });

    expect(result.source.config_json.api_token).toBe('<redacted>');
    expect((result.source.config_json.nested as Record<string, unknown>).app_secret).toBe('<redacted>');
    expect(result.sync_run.assets_seen).toBe(1);
    expect(result.sync_run.assets_changed).toBe(1);
    expect(result.sync_run.assets_uploaded).toBe(1);
    expect(result.assets[0]!.aily_asset_id).toBe('knowledge_asset_1');
    expect(buildManagedBaseMirrorRows(result.snapshot)).toEqual([{
      source_id: 'feishu',
      source_uri: 'https://example.feishu.cn/docx/abc',
      title: 'feishu/docs/roadmap.md',
      content_sha256: 'a'.repeat(64),
      aily_asset_id: 'knowledge_asset_1',
      aily_asset_title: 'rbrain-feishu-roadmap.txt',
      aily_status: 'learning',
      last_synced_at: finishedAt,
    }]);
    expect(JSON.stringify(result.snapshot)).not.toContain('secret-token');
  });

  test('hash-matching assets are tracked as skipped without changing counters', () => {
    const first = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'manual',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: [{
        source_uri: 'feishu/docs/roadmap.md',
        title: 'feishu/docs/roadmap.md',
        content_sha256: 'b'.repeat(64),
        normalized_text_uri: 'feishu/docs/roadmap.md',
        aily_asset_title: 'rbrain-feishu-roadmap.txt',
        aily_asset_id: 'knowledge_asset_1',
        aily_status: 'successful',
        action: 'created',
      }],
    });
    const second = recordManagedSyncResult(first.snapshot, {
      source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
      trigger: 'manual',
      started_at: '2026-06-07T11:00:00.000Z',
      finished_at: '2026-06-07T11:00:01.000Z',
      assets: [{
        source_uri: 'feishu/docs/roadmap.md',
        title: 'feishu/docs/roadmap.md',
        content_sha256: 'b'.repeat(64),
        normalized_text_uri: 'feishu/docs/roadmap.md',
        aily_asset_title: 'rbrain-feishu-roadmap.txt',
        aily_asset_id: 'knowledge_asset_1',
        aily_status: 'successful',
        action: 'skipped_existing',
      }],
    });

    expect(second.sync_run.assets_seen).toBe(1);
    expect(second.sync_run.assets_changed).toBe(0);
    expect(second.sync_run.assets_uploaded).toBe(0);
    expect(second.snapshot.assets).toHaveLength(1);
    expect(second.snapshot.sync_runs).toHaveLength(2);
  });

  test('JSON store round-trips managed registry snapshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbrain-managed-registry-'));
    try {
      const path = join(dir, 'nested', 'registry.json');
      const store = createJsonManagedRegistryStore(path);
      const empty = await store.load();
      const recorded = recordManagedSyncResult(empty, {
        source: { id: 'feishu', kind: 'manual', name: 'Feishu' },
        trigger: 'manual',
        started_at: '2026-06-07T10:00:00.000Z',
        finished_at: '2026-06-07T10:00:01.000Z',
        assets: [{
          source_uri: 'feishu/docs/roadmap.md',
          title: 'feishu/docs/roadmap.md',
          content_sha256: 'c'.repeat(64),
          normalized_text_uri: 'feishu/docs/roadmap.md',
          aily_asset_title: 'rbrain-feishu-roadmap.txt',
          aily_asset_id: 'knowledge_asset_1',
          aily_status: 'successful',
          action: 'created',
        }],
      });

      await store.save(recorded.snapshot);
      const loaded = await store.load();

      expect(store.kind).toBe('json');
      expect(store.location).toBe(path);
      expect(loaded.assets[0]!.source_uri).toBe('feishu/docs/roadmap.md');
      expect(loaded.sync_runs[0]!.id).toBe(recorded.sync_run.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Postgres store loads managed registry rows as a snapshot', async () => {
    const sql = makeFakeManagedSql({
      sources: [{
        id: 'feishu',
        kind: 'manual',
        name: 'Feishu',
        config_json: { mirror_path: '/tmp/rbrain-feishu' },
        enabled: true,
        created_at: new Date('2026-06-07T10:00:00.000Z'),
        updated_at: new Date('2026-06-07T10:00:01.000Z'),
      }],
      assets: [{
        id: 'asset_1',
        source_id: 'feishu',
        source_uri: 'feishu/docs/roadmap.md',
        title: 'feishu/docs/roadmap.md',
        content_sha256: 'd'.repeat(64),
        normalized_text_uri: 'feishu/docs/roadmap.md',
        aily_asset_id: 'knowledge_asset_1',
        aily_asset_title: 'rbrain-feishu-roadmap.txt',
        aily_status: 'successful',
        last_synced_at: new Date('2026-06-07T10:00:01.000Z'),
        created_at: new Date('2026-06-07T10:00:00.000Z'),
        updated_at: new Date('2026-06-07T10:00:01.000Z'),
      }],
      syncRuns: [{
        id: 'sync_1',
        trigger: 'manual',
        source_id: 'feishu',
        status: 'completed',
        started_at: new Date('2026-06-07T10:00:00.000Z'),
        finished_at: new Date('2026-06-07T10:00:01.000Z'),
        assets_seen: '1',
        assets_changed: 1,
        assets_uploaded: 1,
        error_summary: null,
        log_uri: null,
      }],
    });
    const store = createPostgresManagedRegistryStore(sql, 'managed-registry-pg-test');
    const snapshot = await store.load();

    expect(store.kind).toBe('postgres');
    expect(store.location).toBe('managed-registry-pg-test');
    expect(snapshot.sources[0]!.config_json.mirror_path).toBe('/tmp/rbrain-feishu');
    expect(snapshot.assets[0]!.last_synced_at).toBe('2026-06-07T10:00:01.000Z');
    expect(snapshot.sync_runs[0]!.assets_seen).toBe(1);
    expect(snapshot.updated_at).toBe('2026-06-07T10:00:01.000Z');
  });

  test('Postgres store applies schema and upserts managed rows', async () => {
    const sql = makeFakeManagedSql();
    const store = createPostgresManagedRegistryStore(sql);
    const recorded = recordManagedSyncResult(createEmptyManagedRegistry('2026-06-07T10:00:00.000Z'), {
      source: {
        id: 'feishu',
        kind: 'manual',
        name: 'Feishu',
        config_json: { mirror_path: '/tmp/rbrain-feishu' },
      },
      trigger: 'manual',
      started_at: '2026-06-07T10:00:00.000Z',
      finished_at: '2026-06-07T10:00:01.000Z',
      assets: [{
        source_uri: 'feishu/docs/roadmap.md',
        title: 'feishu/docs/roadmap.md',
        content_sha256: 'e'.repeat(64),
        normalized_text_uri: 'feishu/docs/roadmap.md',
        aily_asset_title: 'rbrain-feishu-roadmap.txt',
        aily_asset_id: 'knowledge_asset_1',
        aily_status: 'successful',
        action: 'created',
      }],
    });

    await store.ensureSchema();
    await store.save(recorded.snapshot);

    expect(sql.unsafeCalls[0]).toContain('CREATE TABLE IF NOT EXISTS feishu_managed_sources');
    expect(sql.calls.some((call) => call.includes('INSERT INTO feishu_managed_sources'))).toBe(true);
    expect(sql.calls.some((call) => call.includes('INSERT INTO feishu_managed_assets'))).toBe(true);
    expect(sql.calls.some((call) => call.includes('INSERT INTO feishu_managed_sync_runs'))).toBe(true);
    expect(sql.values.flat()).toContainEqual({ json: { mirror_path: '/tmp/rbrain-feishu' } });
  });

  test('builds stable Base record fields for status mirroring', () => {
    const fields = buildManagedBaseRecordFields({
      source_id: 'feishu',
      source_uri: 'feishu/docs/roadmap.md',
      title: 'feishu/docs/roadmap.md',
      content_sha256: 'c'.repeat(64),
      aily_asset_id: null,
      aily_asset_title: 'rbrain-feishu-roadmap.txt',
      aily_status: 'successful',
      last_synced_at: '2026-06-07T10:00:00.000Z',
    });

    expect(fields[MANAGED_BASE_FIELD_NAMES.sourceUri]).toBe('feishu/docs/roadmap.md');
    expect(fields[MANAGED_BASE_FIELD_NAMES.ailyAssetId]).toBe('');
    expect(fields[MANAGED_BASE_FIELD_NAMES.ailyStatus]).toBe('successful');
    expect(buildManagedBaseTableFieldsJson()).toContainEqual({
      name: MANAGED_BASE_FIELD_NAMES.sourceUri,
      type: 'text',
    });
  });

  test('builds Postgres DDL for the managed registry tables', () => {
    const sql = buildManagedRegistrySqlSchema();

    expect(FEISHU_MANAGED_SQL_SCHEMA_VERSION).toBe(1);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS feishu_managed_sources');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS feishu_managed_assets');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS feishu_managed_sync_runs');
    expect(sql).toContain("kind IN ('doc', 'drive', 'wiki', 'im', 'base', 'manual')");
    expect(sql).toContain("status IN ('running', 'completed', 'partial', 'failed')");
    expect(sql).toContain('UNIQUE (source_id, source_uri)');
    expect(sql).toContain('feishu_managed_sync_runs_source_started_idx');
  });
});
