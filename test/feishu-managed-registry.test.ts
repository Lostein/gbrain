import { describe, expect, test } from 'bun:test';
import {
  buildManagedBaseMirrorRows,
  createEmptyManagedRegistry,
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
});
