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
  recordManagedSyncResult,
} from '../src/core/feishu-managed-registry.ts';

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
