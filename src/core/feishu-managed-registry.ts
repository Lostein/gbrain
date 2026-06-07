import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const FEISHU_MANAGED_REGISTRY_SCHEMA_VERSION = 1;

export type ManagedSourceKind = 'doc' | 'drive' | 'wiki' | 'im' | 'base' | 'manual';
export type ManagedSyncStatus = 'running' | 'completed' | 'partial' | 'failed';

export interface ManagedSourceRow {
  id: string;
  kind: ManagedSourceKind;
  name: string;
  config_json: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ManagedAssetRow {
  id: string;
  source_id: string;
  source_uri: string;
  title: string;
  content_sha256: string;
  normalized_text_uri: string;
  aily_asset_id: string | null;
  aily_asset_title: string;
  aily_status: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManagedSyncRunRow {
  id: string;
  trigger: string;
  source_id: string;
  status: ManagedSyncStatus;
  started_at: string;
  finished_at: string | null;
  assets_seen: number;
  assets_changed: number;
  assets_uploaded: number;
  error_summary: string | null;
  log_uri: string | null;
}

export interface ManagedRegistrySnapshot {
  schema_version: typeof FEISHU_MANAGED_REGISTRY_SCHEMA_VERSION;
  sources: ManagedSourceRow[];
  assets: ManagedAssetRow[];
  sync_runs: ManagedSyncRunRow[];
  updated_at: string;
}

export interface ManagedAssetObservation {
  source_uri: string;
  title: string;
  content_sha256: string;
  normalized_text_uri: string;
  aily_asset_title: string;
  aily_asset_id?: string | null;
  aily_status?: string | null;
  action: string;
  error?: string;
}

export interface ManagedSyncRecordInput {
  source: {
    id: string;
    kind: ManagedSourceKind;
    name: string;
    config_json?: Record<string, unknown>;
    enabled?: boolean;
  };
  trigger: string;
  started_at: string;
  finished_at: string;
  assets: ManagedAssetObservation[];
  log_uri?: string | null;
}

export interface ManagedSyncRecordResult {
  snapshot: ManagedRegistrySnapshot;
  source: ManagedSourceRow;
  sync_run: ManagedSyncRunRow;
  assets: ManagedAssetRow[];
}

export interface ManagedBaseMirrorRow {
  source_id: string;
  source_uri: string;
  title: string;
  content_sha256: string;
  aily_asset_id: string | null;
  aily_asset_title: string;
  aily_status: string | null;
  last_synced_at: string | null;
}

const SECRET_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization)/i;

export function defaultManagedRegistryPath(root: string): string {
  return join(root, '.rbrain-managed', 'registry.json');
}

export function createEmptyManagedRegistry(now = new Date().toISOString()): ManagedRegistrySnapshot {
  return {
    schema_version: FEISHU_MANAGED_REGISTRY_SCHEMA_VERSION,
    sources: [],
    assets: [],
    sync_runs: [],
    updated_at: now,
  };
}

export function loadManagedRegistry(path: string): ManagedRegistrySnapshot {
  if (!existsSync(path)) return createEmptyManagedRegistry();
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ManagedRegistrySnapshot>;
  return {
    schema_version: FEISHU_MANAGED_REGISTRY_SCHEMA_VERSION,
    sources: Array.isArray(parsed.sources) ? parsed.sources as ManagedSourceRow[] : [],
    assets: Array.isArray(parsed.assets) ? parsed.assets as ManagedAssetRow[] : [],
    sync_runs: Array.isArray(parsed.sync_runs) ? parsed.sync_runs as ManagedSyncRunRow[] : [],
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date().toISOString(),
  };
}

export function saveManagedRegistry(path: string, snapshot: ManagedRegistrySnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
}

export function cloneManagedRegistry(snapshot: ManagedRegistrySnapshot): ManagedRegistrySnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ManagedRegistrySnapshot;
}

export function managedAssetId(sourceId: string, sourceUri: string): string {
  return `asset_${createHash('sha256').update(`${sourceId}:${sourceUri}`).digest('hex').slice(0, 16)}`;
}

export function managedSyncRunId(sourceId: string, startedAt: string, trigger: string): string {
  return `sync_${createHash('sha256').update(`${sourceId}:${startedAt}:${trigger}`).digest('hex').slice(0, 16)}`;
}

export function redactManagedConfig(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = value === undefined || value === null || value === '' ? value : '<redacted>';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactManagedConfig(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function recordManagedSyncResult(
  snapshot: ManagedRegistrySnapshot,
  input: ManagedSyncRecordInput,
): ManagedSyncRecordResult {
  const next = cloneManagedRegistry(snapshot);
  const existingSource = next.sources.find((source) => source.id === input.source.id);
  const source: ManagedSourceRow = existingSource ?? {
    id: input.source.id,
    kind: input.source.kind,
    name: input.source.name,
    config_json: {},
    enabled: input.source.enabled ?? true,
    created_at: input.started_at,
    updated_at: input.started_at,
  };
  source.kind = input.source.kind;
  source.name = input.source.name;
  source.config_json = redactManagedConfig(input.source.config_json ?? {});
  source.enabled = input.source.enabled ?? true;
  source.updated_at = input.finished_at;
  if (!existingSource) next.sources.push(source);

  const previousAssets = new Map(next.assets.map((asset) => [asset.id, asset]));
  const observedAssets: ManagedAssetRow[] = [];
  let assetsChanged = 0;
  let assetsUploaded = 0;
  const errors: string[] = [];

  for (const observed of input.assets) {
    const id = managedAssetId(input.source.id, observed.source_uri);
    const previous = previousAssets.get(id);
    const changed = !previous || previous.content_sha256 !== observed.content_sha256 || observed.action === 'created' || observed.action === 'updated';
    if (changed) assetsChanged++;
    if (observed.action === 'created' || observed.action === 'updated') assetsUploaded++;
    if (observed.error) errors.push(`${observed.source_uri}: ${observed.error}`);

    const row: ManagedAssetRow = {
      id,
      source_id: input.source.id,
      source_uri: observed.source_uri,
      title: observed.title,
      content_sha256: observed.content_sha256,
      normalized_text_uri: observed.normalized_text_uri,
      aily_asset_id: observed.aily_asset_id ?? previous?.aily_asset_id ?? null,
      aily_asset_title: observed.aily_asset_title,
      aily_status: observed.aily_status ?? previous?.aily_status ?? null,
      last_synced_at: input.finished_at,
      created_at: previous?.created_at ?? input.started_at,
      updated_at: input.finished_at,
    };

    if (previous) {
      Object.assign(previous, row);
      observedAssets.push(previous);
    } else {
      next.assets.push(row);
      observedAssets.push(row);
    }
  }

  const failed = input.assets.some((asset) => asset.action === 'failed');
  const syncRun: ManagedSyncRunRow = {
    id: managedSyncRunId(input.source.id, input.started_at, input.trigger),
    trigger: input.trigger,
    source_id: input.source.id,
    status: failed ? 'partial' : 'completed',
    started_at: input.started_at,
    finished_at: input.finished_at,
    assets_seen: input.assets.length,
    assets_changed: assetsChanged,
    assets_uploaded: assetsUploaded,
    error_summary: errors.length > 0 ? errors.slice(0, 3).join('; ') : null,
    log_uri: input.log_uri ?? null,
  };
  next.sync_runs.push(syncRun);
  next.updated_at = input.finished_at;

  return { snapshot: next, source, sync_run: syncRun, assets: observedAssets };
}

export function buildManagedBaseMirrorRows(snapshot: ManagedRegistrySnapshot): ManagedBaseMirrorRow[] {
  return snapshot.assets
    .slice()
    .sort((a, b) => a.source_uri.localeCompare(b.source_uri))
    .map((asset) => ({
      source_id: asset.source_id,
      source_uri: asset.source_uri,
      title: asset.title,
      content_sha256: asset.content_sha256,
      aily_asset_id: asset.aily_asset_id,
      aily_asset_title: asset.aily_asset_title,
      aily_status: asset.aily_status,
      last_synced_at: asset.last_synced_at,
    }));
}
