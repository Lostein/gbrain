import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const FEISHU_MANAGED_REGISTRY_SCHEMA_VERSION = 1;
export const FEISHU_MANAGED_SQL_SCHEMA_VERSION = 1;

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

export interface ManagedRegistryStore {
  readonly kind: string;
  readonly location: string;
  load(): Promise<ManagedRegistrySnapshot>;
  save(snapshot: ManagedRegistrySnapshot): Promise<void>;
}

export interface ManagedRegistrySqlClient {
  <T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  begin?<T>(fn: (sql: ManagedRegistrySqlClient) => Promise<T>): Promise<T>;
  unsafe?(query: string): Promise<unknown>;
  json?(value: unknown): unknown;
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

export const MANAGED_BASE_FIELD_NAMES = {
  sourceId: 'Source ID',
  sourceUri: 'Source URI',
  title: 'Title',
  contentSha256: 'Content SHA256',
  ailyAssetId: 'Aily Asset ID',
  ailyAssetTitle: 'Aily Asset Title',
  ailyStatus: 'Aily Status',
  lastSyncedAt: 'Last Synced At',
} as const;

export type ManagedBaseFieldName = typeof MANAGED_BASE_FIELD_NAMES[keyof typeof MANAGED_BASE_FIELD_NAMES];
export type ManagedBaseRecordFields = Record<ManagedBaseFieldName, string>;

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

export class JsonManagedRegistryStore implements ManagedRegistryStore {
  readonly kind = 'json';
  readonly location: string;

  constructor(path: string) {
    this.location = path;
  }

  async load(): Promise<ManagedRegistrySnapshot> {
    return loadManagedRegistry(this.location);
  }

  async save(snapshot: ManagedRegistrySnapshot): Promise<void> {
    saveManagedRegistry(this.location, snapshot);
  }
}

export function createJsonManagedRegistryStore(path: string): ManagedRegistryStore {
  return new JsonManagedRegistryStore(path);
}

export class PostgresManagedRegistryStore implements ManagedRegistryStore {
  readonly kind = 'postgres';
  readonly location: string;
  private readonly sql: ManagedRegistrySqlClient;

  constructor(sql: ManagedRegistrySqlClient, location = 'postgres') {
    this.sql = sql;
    this.location = location;
  }

  async ensureSchema(): Promise<void> {
    if (!this.sql.unsafe) {
      throw new Error('PostgresManagedRegistryStore.ensureSchema requires a SQL client with unsafe().');
    }
    await this.sql.unsafe(buildManagedRegistrySqlSchema());
  }

  async load(): Promise<ManagedRegistrySnapshot> {
    const [sources, assets, syncRuns] = await Promise.all([
      this.sql<Record<string, unknown>>`
        SELECT id, kind, name, config_json, enabled, created_at, updated_at
        FROM feishu_managed_sources
        ORDER BY id
      `,
      this.sql<Record<string, unknown>>`
        SELECT id, source_id, source_uri, title, content_sha256, normalized_text_uri,
               aily_asset_id, aily_asset_title, aily_status, last_synced_at, created_at, updated_at
        FROM feishu_managed_assets
        ORDER BY source_id, source_uri
      `,
      this.sql<Record<string, unknown>>`
        SELECT id, trigger, source_id, status, started_at, finished_at, assets_seen,
               assets_changed, assets_uploaded, error_summary, log_uri
        FROM feishu_managed_sync_runs
        ORDER BY started_at, id
      `,
    ]);

    const updatedAt = latestTimestamp([
      ...sources.map((row) => row.updated_at),
      ...assets.map((row) => row.updated_at),
      ...syncRuns.map((row) => row.finished_at),
    ]);
    return {
      schema_version: FEISHU_MANAGED_REGISTRY_SCHEMA_VERSION,
      sources: sources.map(rowToManagedSource),
      assets: assets.map(rowToManagedAsset),
      sync_runs: syncRuns.map(rowToManagedSyncRun),
      updated_at: updatedAt ?? new Date().toISOString(),
    };
  }

  async save(snapshot: ManagedRegistrySnapshot): Promise<void> {
    const write = async (sql: ManagedRegistrySqlClient) => {
      for (const source of snapshot.sources) {
        await sql`
          INSERT INTO feishu_managed_sources
            (id, kind, name, config_json, enabled, created_at, updated_at)
          VALUES
            (${source.id}, ${source.kind}, ${source.name}, ${sqlJson(sql, source.config_json)},
             ${source.enabled}, ${source.created_at}, ${source.updated_at})
          ON CONFLICT (id) DO UPDATE SET
            kind = EXCLUDED.kind,
            name = EXCLUDED.name,
            config_json = EXCLUDED.config_json,
            enabled = EXCLUDED.enabled,
            updated_at = EXCLUDED.updated_at
        `;
      }

      for (const asset of snapshot.assets) {
        await sql`
          INSERT INTO feishu_managed_assets
            (id, source_id, source_uri, title, content_sha256, normalized_text_uri,
             aily_asset_id, aily_asset_title, aily_status, last_synced_at, created_at, updated_at)
          VALUES
            (${asset.id}, ${asset.source_id}, ${asset.source_uri}, ${asset.title},
             ${asset.content_sha256}, ${asset.normalized_text_uri}, ${asset.aily_asset_id},
             ${asset.aily_asset_title}, ${asset.aily_status}, ${asset.last_synced_at},
             ${asset.created_at}, ${asset.updated_at})
          ON CONFLICT (id) DO UPDATE SET
            source_uri = EXCLUDED.source_uri,
            title = EXCLUDED.title,
            content_sha256 = EXCLUDED.content_sha256,
            normalized_text_uri = EXCLUDED.normalized_text_uri,
            aily_asset_id = EXCLUDED.aily_asset_id,
            aily_asset_title = EXCLUDED.aily_asset_title,
            aily_status = EXCLUDED.aily_status,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = EXCLUDED.updated_at
        `;
      }

      for (const syncRun of snapshot.sync_runs) {
        await sql`
          INSERT INTO feishu_managed_sync_runs
            (id, trigger, source_id, status, started_at, finished_at, assets_seen,
             assets_changed, assets_uploaded, error_summary, log_uri)
          VALUES
            (${syncRun.id}, ${syncRun.trigger}, ${syncRun.source_id}, ${syncRun.status},
             ${syncRun.started_at}, ${syncRun.finished_at}, ${syncRun.assets_seen},
             ${syncRun.assets_changed}, ${syncRun.assets_uploaded}, ${syncRun.error_summary},
             ${syncRun.log_uri})
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            assets_seen = EXCLUDED.assets_seen,
            assets_changed = EXCLUDED.assets_changed,
            assets_uploaded = EXCLUDED.assets_uploaded,
            error_summary = EXCLUDED.error_summary,
            log_uri = EXCLUDED.log_uri
        `;
      }
    };

    if (this.sql.begin) await this.sql.begin(write);
    else await write(this.sql);
  }
}

export function createPostgresManagedRegistryStore(
  sql: ManagedRegistrySqlClient,
  location = 'postgres',
): PostgresManagedRegistryStore {
  return new PostgresManagedRegistryStore(sql, location);
}

function sqlJson(sql: ManagedRegistrySqlClient, value: unknown): unknown {
  return sql.json ? sql.json(value) : value;
}

function timestampString(value: unknown, fallback = new Date(0).toISOString()): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

function optionalTimestampString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return timestampString(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function latestTimestamp(values: unknown[]): string | null {
  const times = values
    .map((value) => {
      const iso = optionalTimestampString(value);
      return iso ? Date.parse(iso) : Number.NaN;
    })
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

function rowToManagedSource(row: Record<string, unknown>): ManagedSourceRow {
  return {
    id: String(row.id),
    kind: parseManagedSourceKind(row.kind),
    name: String(row.name),
    config_json: objectRecord(row.config_json),
    enabled: row.enabled !== false,
    created_at: timestampString(row.created_at),
    updated_at: timestampString(row.updated_at),
  };
}

function rowToManagedAsset(row: Record<string, unknown>): ManagedAssetRow {
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    source_uri: String(row.source_uri),
    title: String(row.title),
    content_sha256: String(row.content_sha256),
    normalized_text_uri: String(row.normalized_text_uri),
    aily_asset_id: optionalString(row.aily_asset_id),
    aily_asset_title: String(row.aily_asset_title),
    aily_status: optionalString(row.aily_status),
    last_synced_at: optionalTimestampString(row.last_synced_at),
    created_at: timestampString(row.created_at),
    updated_at: timestampString(row.updated_at),
  };
}

function rowToManagedSyncRun(row: Record<string, unknown>): ManagedSyncRunRow {
  return {
    id: String(row.id),
    trigger: String(row.trigger),
    source_id: String(row.source_id),
    status: parseManagedSyncStatus(row.status),
    started_at: timestampString(row.started_at),
    finished_at: optionalTimestampString(row.finished_at),
    assets_seen: numberOrZero(row.assets_seen),
    assets_changed: numberOrZero(row.assets_changed),
    assets_uploaded: numberOrZero(row.assets_uploaded),
    error_summary: optionalString(row.error_summary),
    log_uri: optionalString(row.log_uri),
  };
}

function parseManagedSourceKind(value: unknown): ManagedSourceKind {
  if (
    value === 'doc' ||
    value === 'drive' ||
    value === 'wiki' ||
    value === 'im' ||
    value === 'base' ||
    value === 'manual'
  ) {
    return value;
  }
  return 'manual';
}

function parseManagedSyncStatus(value: unknown): ManagedSyncStatus {
  if (value === 'running' || value === 'completed' || value === 'partial' || value === 'failed') return value;
  return 'failed';
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

export function buildManagedBaseRecordFields(row: ManagedBaseMirrorRow): ManagedBaseRecordFields {
  return {
    [MANAGED_BASE_FIELD_NAMES.sourceId]: row.source_id,
    [MANAGED_BASE_FIELD_NAMES.sourceUri]: row.source_uri,
    [MANAGED_BASE_FIELD_NAMES.title]: row.title,
    [MANAGED_BASE_FIELD_NAMES.contentSha256]: row.content_sha256,
    [MANAGED_BASE_FIELD_NAMES.ailyAssetId]: row.aily_asset_id ?? '',
    [MANAGED_BASE_FIELD_NAMES.ailyAssetTitle]: row.aily_asset_title,
    [MANAGED_BASE_FIELD_NAMES.ailyStatus]: row.aily_status ?? '',
    [MANAGED_BASE_FIELD_NAMES.lastSyncedAt]: row.last_synced_at ?? '',
  };
}

export function buildManagedBaseTableFieldsJson(): Array<{ name: ManagedBaseFieldName; type: 'text' }> {
  return Object.values(MANAGED_BASE_FIELD_NAMES).map((name) => ({ name, type: 'text' as const }));
}

export function buildManagedRegistrySqlSchema(): string {
  return [
    '-- RBrain Feishu Native managed registry schema',
    `-- schema_version: ${FEISHU_MANAGED_SQL_SCHEMA_VERSION}`,
    '',
    'CREATE TABLE IF NOT EXISTS feishu_managed_sources (',
    '  id TEXT PRIMARY KEY,',
    "  kind TEXT NOT NULL CHECK (kind IN ('doc', 'drive', 'wiki', 'im', 'base', 'manual')),",
    '  name TEXT NOT NULL,',
    "  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,",
    '  enabled BOOLEAN NOT NULL DEFAULT TRUE,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
    '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS feishu_managed_assets (',
    '  id TEXT PRIMARY KEY,',
    '  source_id TEXT NOT NULL REFERENCES feishu_managed_sources(id) ON DELETE CASCADE,',
    '  source_uri TEXT NOT NULL,',
    '  title TEXT NOT NULL,',
    '  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ \'^[a-f0-9]{64}$\'),',
    '  normalized_text_uri TEXT NOT NULL,',
    '  aily_asset_id TEXT,',
    '  aily_asset_title TEXT NOT NULL,',
    '  aily_status TEXT,',
    '  last_synced_at TIMESTAMPTZ,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
    '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
    '  UNIQUE (source_id, source_uri),',
    '  UNIQUE (source_id, aily_asset_title)',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS feishu_managed_sync_runs (',
    '  id TEXT PRIMARY KEY,',
    '  trigger TEXT NOT NULL,',
    '  source_id TEXT NOT NULL REFERENCES feishu_managed_sources(id) ON DELETE CASCADE,',
    "  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),",
    '  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
    '  finished_at TIMESTAMPTZ,',
    '  assets_seen INTEGER NOT NULL DEFAULT 0 CHECK (assets_seen >= 0),',
    '  assets_changed INTEGER NOT NULL DEFAULT 0 CHECK (assets_changed >= 0),',
    '  assets_uploaded INTEGER NOT NULL DEFAULT 0 CHECK (assets_uploaded >= 0),',
    '  error_summary TEXT,',
    '  log_uri TEXT',
    ');',
    '',
    'CREATE INDEX IF NOT EXISTS feishu_managed_sources_enabled_idx',
    '  ON feishu_managed_sources (enabled) WHERE enabled = TRUE;',
    '',
    'CREATE INDEX IF NOT EXISTS feishu_managed_assets_source_idx',
    '  ON feishu_managed_assets (source_id);',
    '',
    'CREATE INDEX IF NOT EXISTS feishu_managed_assets_aily_status_idx',
    '  ON feishu_managed_assets (aily_status);',
    '',
    'CREATE INDEX IF NOT EXISTS feishu_managed_assets_last_synced_idx',
    '  ON feishu_managed_assets (last_synced_at DESC);',
    '',
    'CREATE INDEX IF NOT EXISTS feishu_managed_sync_runs_source_started_idx',
    '  ON feishu_managed_sync_runs (source_id, started_at DESC);',
    '',
  ].join('\n');
}
