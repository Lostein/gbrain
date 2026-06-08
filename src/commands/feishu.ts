import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import postgres from 'postgres';
import type { BrainEngine } from '../core/engine.ts';
import { resolvePoolSize, resolvePrepare, resolveSessionTimeouts } from '../core/db.ts';
import { assertValidSourceId } from '../core/source-id.ts';
import { addSource as addBrainSource, SourceOpError } from '../core/sources-ops.ts';
import { redactDeep, redactPgUrl } from '../core/url-redact.ts';
import {
  MANAGED_BASE_FIELD_NAMES,
  FEISHU_MANAGED_SQL_SCHEMA_VERSION,
  buildManagedBaseRecordFields,
  buildManagedBaseTableFieldsJson,
  buildManagedBaseMirrorRows,
  buildManagedRegistrySqlSchema,
  cloneManagedRegistry,
  createJsonManagedRegistryStore,
  createPostgresManagedRegistryStore,
  defaultManagedRegistryPath,
  recordManagedSyncResult,
  type ManagedAssetRow,
  type ManagedAssetObservation,
  type ManagedBaseMirrorRow,
  type ManagedRegistrySqlClient,
  type ManagedRegistrySnapshot,
  type ManagedRegistryStore,
  type ManagedSourceKind,
  type ManagedSyncRunRow,
} from '../core/feishu-managed-registry.ts';

export const FEISHU_MIRROR_DIRS = [
  'feishu/docs',
  'feishu/drive',
  'feishu/wiki',
  'feishu/minutes',
  'feishu/calendar',
  'feishu/tasks',
  'feishu/im',
  'feishu/mail',
  'feishu/base',
  'feishu/approvals',
  'feishu/okr',
  'scripts',
] as const;

const FEISHU_STATUS_DIRS = FEISHU_MIRROR_DIRS.filter((dir) => dir.startsWith('feishu/'));

const AILY_DEFAULT_HOST = 'https://apaas.feishu.cn';
const AILY_DEFAULT_SOURCE_URL_BASE = 'https://rbrain.local/feishu-mirror';
const AILY_DEFAULT_TOKEN_ENV = 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN';
const AILY_FALLBACK_TOKEN_ENV = 'AILY_KNOWLEDGE_SPACE_API_TOKEN';
const AILY_DEFAULT_SPACE_ID_ENV = 'RBRAIN_AILY_KNOWLEDGE_SPACE_ID';
const AILY_FALLBACK_SPACE_ID_ENV = 'AILY_KNOWLEDGE_SPACE_ID';
const MANAGED_REGISTRY_STORE_ENV = 'RBRAIN_FEISHU_MANAGED_REGISTRY_STORE';
const MANAGED_REGISTRY_DATABASE_URL_ENV = 'RBRAIN_FEISHU_MANAGED_DATABASE_URL';
const MANAGED_TRIGGER_TEMPLATE_IMPORT = 'gbrain/feishu-managed';
const MANAGED_DEPLOY_PACKAGE_DEPENDENCY = 'github:Lostein/gbrain';
const MANAGED_DEPLOY_BUNDLE_DEFAULT_DIR = './feishu-managed-deploy';
const MANAGED_INLINE_SOURCES_JSON_ENV = 'RBRAIN_FEISHU_INLINE_SOURCES_JSON';
const MANAGED_INLINE_CANARY_ASSET_JSON = JSON.stringify({
  sourceUri: 'https://feishu.example/doc/smoke',
  normalizedTextUri: 'feishu/docs/smoke.md',
  content: '# Smoke\n\nInline sample text.',
});
const MANAGED_MIRROR_ROOT_ENV = 'RBRAIN_FEISHU_MIRROR_ROOT';
const MANAGED_BASE_TOKEN_ENV = 'RBRAIN_FEISHU_MANAGED_BASE_TOKEN';
const MANAGED_BASE_TABLE_ID_ENV = 'RBRAIN_FEISHU_MANAGED_BASE_TABLE_ID';
const MANAGED_BASE_AS_ENV = 'RBRAIN_FEISHU_MANAGED_BASE_AS';
const MANAGED_TRIGGER_TEMPLATE_ENV = [
  MANAGED_MIRROR_ROOT_ENV,
  MANAGED_REGISTRY_DATABASE_URL_ENV,
  AILY_DEFAULT_SPACE_ID_ENV,
  AILY_DEFAULT_TOKEN_ENV,
  MANAGED_BASE_TOKEN_ENV,
  MANAGED_BASE_TABLE_ID_ENV,
] as const;
const AILY_MAX_ASSET_BYTES = 30 * 1024 * 1024;
const AILY_OVERVIEW_RELATIVE_PATH = 'feishu/rbrain-feishu-overview.md';

export const FEISHU_DOCTOR_CAPABILITY_CHECKS = [
  { id: 'collector:calendar-agenda', argv: ['lark-cli', 'calendar', '+agenda', '--help'] },
  { id: 'collector:tasks', argv: ['lark-cli', 'task', '+get-my-tasks', '--help'] },
  { id: 'collector:docs-fetch', argv: ['lark-cli', 'docs', '+fetch', '--help'] },
  { id: 'collector:drive-search', argv: ['lark-cli', 'drive', '+search', '--help'] },
  { id: 'collector:wiki-spaces', argv: ['lark-cli', 'wiki', '+space-list', '--help'] },
  { id: 'collector:wiki-nodes', argv: ['lark-cli', 'wiki', '+node-list', '--help'] },
  { id: 'collector:minutes-search', argv: ['lark-cli', 'minutes', '+search', '--help'] },
  { id: 'collector:mail-triage', argv: ['lark-cli', 'mail', '+triage', '--help'] },
  { id: 'collector:approval-tasks', argv: ['lark-cli', 'approval', 'tasks', 'query', '--help'] },
  { id: 'collector:approval-initiated', argv: ['lark-cli', 'approval', 'instances', 'initiated', '--help'] },
  { id: 'collector:okr-cycles', argv: ['lark-cli', 'okr', '+cycle-list', '--help'] },
  { id: 'collector:okr-cycle-detail', argv: ['lark-cli', 'okr', '+cycle-detail', '--help'] },
  { id: 'collector:base-tables', argv: ['lark-cli', 'base', '+table-list', '--help'] },
  { id: 'collector:base-fields', argv: ['lark-cli', 'base', '+field-list', '--help'] },
  { id: 'collector:base-records', argv: ['lark-cli', 'base', '+record-list', '--help'] },
  { id: 'collector:base-search', argv: ['lark-cli', 'base', '+record-search', '--help'] },
  { id: 'collector:im-chat-list', argv: ['lark-cli', 'im', '+chat-list', '--help'] },
  { id: 'collector:im-chat-search', argv: ['lark-cli', 'im', '+chat-search', '--help'] },
  { id: 'collector:im-chat-messages', argv: ['lark-cli', 'im', '+chat-messages-list', '--help'] },
  { id: 'collector:im-message-search', argv: ['lark-cli', 'im', '+messages-search', '--help'] },
  { id: 'collector:im-flags', argv: ['lark-cli', 'im', '+flag-list', '--help'] },
] as const;

interface InitOpts {
  path: string;
  force: boolean;
  json: boolean;
  git: boolean;
}

interface DoctorOpts {
  json: boolean;
}

interface SetupOpts extends InitOpts {
  sourceId: string;
  name: string;
  setDefault: boolean;
  sync: boolean;
  noEmbed: boolean;
}

interface PullOpts {
  kind:
    | 'agenda'
    | 'doc'
    | 'docs-list'
    | 'approval-initiated'
    | 'approval-tasks'
    | 'base-fields'
    | 'base-records'
    | 'base-search'
    | 'base-tables'
    | 'drive-search'
    | 'im-chat-list'
    | 'im-chat-messages'
    | 'im-chat-search'
    | 'im-flags'
    | 'im-message-search'
    | 'mail-triage'
    | 'minutes-search'
    | 'okr-cycle-detail'
    | 'okr-cycles'
    | 'tasks'
    | 'wiki-nodes'
    | 'wiki-spaces';
  path?: string;
  sourceId: string;
  sync: boolean;
  noEmbed: boolean;
  json: boolean;
  doc?: string;
  slug?: string;
  file?: string;
  query?: string;
  filter?: string;
  baseToken?: string;
  tableId?: string;
  viewId?: string;
  fieldIds?: string[];
  searchJson?: string;
  limit?: string;
  offset?: string;
  chatId?: string;
  userId?: string;
  chatType?: string;
  types?: string;
  memberIds?: string;
  searchTypes?: string;
  sortBy?: string;
  sortType?: string;
  sender?: string;
  senderType?: string;
  excludeSenderType?: string;
  atChatterIds?: string;
  includeAttachmentType?: string;
  pageToken?: string;
  excludeMuted?: boolean;
  isAtMe?: boolean;
  isManager?: boolean;
  noReactions?: boolean;
  enrichFeedThread?: boolean;
  docTypes?: string;
  spaceIds?: string;
  spaceId?: string;
  folderTokens?: string;
  parentNodeToken?: string;
  sort?: string;
  editedSince?: string;
  editedUntil?: string;
  openedSince?: string;
  openedUntil?: string;
  createdSince?: string;
  createdUntil?: string;
  pageSize?: string;
  pageLimit?: string;
  pageAll?: boolean;
  params?: string;
  mine?: boolean;
  onlyTitle?: boolean;
  start?: string;
  end?: string;
  max?: string;
  mailbox?: string;
  labels?: boolean;
  complete?: boolean;
  createdAt?: string;
  dueStart?: string;
  dueEnd?: string;
  timeRange?: string;
  userIdType?: string;
  cycleId?: string;
  targetId?: string;
  targetType?: string;
  departmentIdType?: string;
}

interface RefreshOpts {
  path?: string;
  sourceId: string;
  sync: boolean;
  noEmbed: boolean;
  json: boolean;
  agenda: boolean;
  tasks: boolean;
  taskQuery?: string;
  taskComplete?: boolean;
  dueStart?: string;
  dueEnd?: string;
  minutesQuery?: string;
  minutesStart?: string;
  minutesEnd?: string;
  driveQuery?: string;
  driveDocTypes?: string;
  driveMine?: boolean;
  drivePageSize?: string;
  mailQuery?: string;
  mailMax?: string;
  mailLabels?: boolean;
  approvalTasks: boolean;
  approvalInitiated: boolean;
  approvalParams?: string;
  okrCycles: boolean;
  okrTimeRange?: string;
  okrUserId?: string;
  okrUserIdType?: string;
  okrCycleId?: string;
  baseToken?: string;
  baseTableId?: string;
  baseViewId?: string;
  baseFieldIds?: string[];
  baseSearchJson?: string;
  baseLimit?: string;
  baseOffset?: string;
  baseTables: boolean;
  baseFields: boolean;
  baseRecords: boolean;
  baseSearch: boolean;
  imQuery?: string;
  imChatId?: string;
  imUserId?: string;
  imStart?: string;
  imEnd?: string;
  imPageSize?: string;
  imPageLimit?: string;
  imFlags: boolean;
  wikiSpaces: boolean;
  wikiSpaceId?: string;
  wikiParentNodeToken?: string;
  wikiPageSize?: string;
  wikiPageLimit?: string;
  wikiPageAll?: boolean;
}

interface StatusOpts {
  path?: string;
  sourceId: string;
  json: boolean;
}

export interface AilyPushSpaceOpts {
  path?: string;
  sourceId: string;
  host: string;
  knowledgeSpaceId: string;
  tokenEnv: string;
  envFile?: string;
  sourceUrlBase: string;
  limit?: number;
  replace: boolean;
  dryRun: boolean;
  json: boolean;
}

export interface ManagedSyncOpts extends AilyPushSpaceOpts {
  registryPath?: string;
  registryStore: ManagedRegistryStoreKind;
  registryUrl?: string;
  registryEnsureSchema: boolean;
  trigger: string;
  sourceKind: ManagedSourceKind;
  sourceName: string;
  baseToken?: string;
  baseTableId?: string;
  baseAs?: string;
}

export interface ManagedRegistryStatusOpts {
  path?: string;
  sourceId: string;
  registryPath?: string;
  registryStore: ManagedRegistryStoreKind;
  registryUrl?: string;
  registryEnsureSchema: boolean;
  json: boolean;
}

export interface ManagedRegistryProvisionOpts extends ManagedRegistryStatusOpts {
  registryStore: 'postgres';
  registryUrl: string;
  registryEnsureSchema: true;
}

export interface ManagedRefreshStatusOpts extends ManagedRegistryStatusOpts {
  host: string;
  knowledgeSpaceId: string;
  tokenEnv: string;
  dryRun: boolean;
  limit?: number;
  baseToken?: string;
  baseTableId?: string;
  baseAs?: string;
}

export interface ManagedWaitStatusOpts extends ManagedRefreshStatusOpts {
  targetStatus: string;
  timeoutMs: number;
  intervalMs: number;
}

interface ManagedBaseProvisionOpts {
  baseToken?: string;
  tableName: string;
  as?: string;
  dryRun: boolean;
  json: boolean;
}

export type ManagedRegistryStoreKind = 'json' | 'postgres';

interface FeishuContext {
  engine?: BrainEngine;
}

type FileWriteStatus = 'created' | 'updated' | 'skipped';

interface MirrorFile {
  path: string;
  status: FileWriteStatus;
}

interface MirrorGitStatus {
  repository: 'existing' | 'initialized' | 'skipped' | 'unavailable' | 'failed';
  commit: 'created' | 'clean' | 'skipped' | 'failed';
  error?: string;
}

interface MirrorInitResult {
  status: 'ok';
  path: string;
  dirs: string[];
  files: MirrorFile[];
  git: MirrorGitStatus;
  next: string[];
}

interface SourceSetupResult {
  source_id: string;
  status: 'created' | 'updated' | 'already_registered';
  path: string;
  name: string;
  federated: true;
  default: boolean;
}

interface PullResult {
  status: 'ok';
  kind: PullOpts['kind'];
  path: string;
  output: string;
  command: string[];
  commit: MirrorGitStatus['commit'];
  sync: unknown;
}

type SnapshotResult = Omit<PullResult, 'sync'>;

export interface DocManifestEntry {
  doc: string;
  slug?: string;
  line: number;
}

interface CapturedResult<T> {
  result: T;
  stdout: string;
}

interface FeishuSourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_sync_at: string | Date | null;
  last_commit: string | null;
  config: unknown;
}

interface SnapshotDomainStatus {
  domain: string;
  path: string;
  markdown_files: number;
  latest: string | null;
}

interface MirrorGitInspection {
  state: 'clean' | 'dirty' | 'missing' | 'unavailable' | 'failed';
  head: string | null;
  dirty_files: number;
  error?: string;
}

export interface AilyPushCandidate {
  path: string;
  relative_path: string;
  title: string;
  source_url: string;
  bytes: number;
  content_sha256: string;
  content?: string;
}

export interface ManagedInlineAssetInput {
  sourceUri: string;
  content: string;
  title?: string;
  normalizedTextUri?: string;
  sourceUrl?: string;
  ailyAssetTitle?: string;
}

export type AilyPushAction =
  | 'created'
  | 'updated'
  | 'skipped_existing'
  | 'skipped_oversize'
  | 'dry_run_create'
  | 'dry_run_update'
  | 'dry_run_skip_existing'
  | 'failed';

export interface AilyPushItemResult extends AilyPushCandidate {
  action: AilyPushAction;
  knowledge_asset_id?: string;
  asset_status?: string;
  error?: string;
}

export interface AilyPushSpaceResult {
  status: 'ok' | 'partial';
  host: string;
  knowledge_space_id: string;
  path: string;
  dry_run: boolean;
  replace: boolean;
  candidates: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  assets: AilyPushItemResult[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type EnvLookup = Record<string, string | undefined>;

function brand(): string {
  return process.env.RBRAIN_MODE === '1' ? 'rbrain' : 'gbrain';
}

export function expandPath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return resolve(input);
}

function parseFlagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseRepeatedFlagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) out.push(args[i + 1]!);
  }
  return out;
}

function parseInit(args: string[]): InitOpts {
  const path = parseFlagValue(args, '--path') ?? '~/rbrain-feishu';
  return {
    path: expandPath(path),
    force: args.includes('--force'),
    json: args.includes('--json'),
    git: !args.includes('--no-git'),
  };
}

function parseDoctor(args: string[]): DoctorOpts {
  return { json: args.includes('--json') };
}

function parseSetup(args: string[]): SetupOpts {
  const base = parseInit(args);
  return {
    ...base,
    sourceId: parseFlagValue(args, '--source-id') ?? 'feishu',
    name: parseFlagValue(args, '--name') ?? 'Feishu',
    setDefault: !args.includes('--no-default'),
    sync: args.includes('--sync'),
    noEmbed: !args.includes('--embed'),
  };
}

function nonFlagArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (
        [
          '--path',
          '--source-id',
          '--name',
          '--doc',
          '--slug',
          '--file',
          '--manifest',
          '--query',
          '--filter',
          '--base-token',
          '--base-table-id',
          '--base-view-id',
          '--base-field-id',
          '--base-search-json',
          '--base-limit',
          '--base-offset',
          '--table-id',
          '--view-id',
          '--field-id',
          '--search-json',
          '--limit',
          '--offset',
          '--chat-id',
          '--chat-type',
          '--types',
          '--member-ids',
          '--search-types',
          '--sort-by',
          '--sort-type',
          '--sender',
          '--sender-type',
          '--exclude-sender-type',
          '--at-chatter-ids',
          '--include-attachment-type',
          '--page-token',
          '--doc-types',
          '--space-ids',
          '--space-id',
          '--folder-tokens',
          '--parent-node-token',
          '--sort',
          '--edited-since',
          '--edited-until',
          '--opened-since',
          '--opened-until',
          '--created-since',
          '--created-until',
          '--page-size',
          '--page-limit',
          '--params',
          '--start',
          '--end',
          '--max',
          '--mailbox',
          '--created-at',
          '--due-start',
          '--due-end',
          '--time-range',
          '--user-id',
          '--user-id-type',
          '--cycle-id',
          '--target-id',
          '--target-type',
          '--department-id-type',
        ].includes(a) &&
        i + 1 < args.length
      ) {
        i++;
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

function parsePull(args: string[]): PullOpts {
  const kind = args[0] as PullOpts['kind'] | undefined;
  if (
    kind !== 'agenda' &&
    kind !== 'doc' &&
    kind !== 'docs-list' &&
    kind !== 'approval-initiated' &&
    kind !== 'approval-tasks' &&
    kind !== 'base-fields' &&
    kind !== 'base-records' &&
    kind !== 'base-search' &&
    kind !== 'base-tables' &&
    kind !== 'drive-search' &&
    kind !== 'im-chat-list' &&
    kind !== 'im-chat-messages' &&
    kind !== 'im-chat-search' &&
    kind !== 'im-flags' &&
    kind !== 'im-message-search' &&
    kind !== 'mail-triage' &&
    kind !== 'minutes-search' &&
    kind !== 'okr-cycle-detail' &&
    kind !== 'okr-cycles' &&
    kind !== 'tasks' &&
    kind !== 'wiki-nodes' &&
    kind !== 'wiki-spaces'
  ) {
    throw new Error(`Usage: ${brand()} feishu pull <agenda|approval-initiated|approval-tasks|base-fields|base-records|base-search|base-tables|doc|docs-list|drive-search|im-chat-list|im-chat-messages|im-chat-search|im-flags|im-message-search|mail-triage|minutes-search|okr-cycle-detail|okr-cycles|tasks|wiki-nodes|wiki-spaces> [options]`);
  }
  const positionals = nonFlagArgs(args.slice(1));
  const complete = args.includes('--complete')
    ? true
    : args.includes('--incomplete')
      ? false
      : undefined;
  return {
    kind,
    path: parseFlagValue(args, '--path') ? expandPath(parseFlagValue(args, '--path')!) : undefined,
    sourceId: parseFlagValue(args, '--source-id') ?? 'feishu',
    sync: args.includes('--sync'),
    noEmbed: !args.includes('--embed'),
    json: args.includes('--json'),
    doc: parseFlagValue(args, '--doc') ?? positionals[0],
    slug: parseFlagValue(args, '--slug') ?? positionals[1],
    file: parseFlagValue(args, '--file') ?? parseFlagValue(args, '--manifest') ?? positionals[0],
    query: parseFlagValue(args, '--query') ?? positionals[0],
    filter: parseFlagValue(args, '--filter'),
    baseToken: parseFlagValue(args, '--base-token') ?? positionals[0],
    tableId: parseFlagValue(args, '--table-id') ?? positionals[1],
    viewId: parseFlagValue(args, '--view-id'),
    fieldIds: parseRepeatedFlagValues(args, '--field-id'),
    searchJson: parseFlagValue(args, '--search-json') ?? positionals[2],
    limit: parseFlagValue(args, '--limit'),
    offset: parseFlagValue(args, '--offset'),
    chatId: parseFlagValue(args, '--chat-id') ?? positionals[0],
    userId: parseFlagValue(args, '--user-id'),
    chatType: parseFlagValue(args, '--chat-type'),
    types: parseFlagValue(args, '--types'),
    memberIds: parseFlagValue(args, '--member-ids'),
    searchTypes: parseFlagValue(args, '--search-types'),
    sortBy: parseFlagValue(args, '--sort-by'),
    sortType: parseFlagValue(args, '--sort-type'),
    sender: parseFlagValue(args, '--sender'),
    senderType: parseFlagValue(args, '--sender-type'),
    excludeSenderType: parseFlagValue(args, '--exclude-sender-type'),
    atChatterIds: parseFlagValue(args, '--at-chatter-ids'),
    includeAttachmentType: parseFlagValue(args, '--include-attachment-type'),
    pageToken: parseFlagValue(args, '--page-token'),
    excludeMuted: args.includes('--exclude-muted'),
    isAtMe: args.includes('--is-at-me'),
    isManager: args.includes('--is-manager'),
    noReactions: args.includes('--no-reactions'),
    enrichFeedThread: args.includes('--no-enrich-feed-thread') ? false : undefined,
    docTypes: parseFlagValue(args, '--doc-types'),
    spaceIds: parseFlagValue(args, '--space-ids'),
    spaceId: parseFlagValue(args, '--space-id') ?? positionals[0],
    folderTokens: parseFlagValue(args, '--folder-tokens'),
    parentNodeToken: parseFlagValue(args, '--parent-node-token') ?? positionals[1],
    sort: parseFlagValue(args, '--sort'),
    editedSince: parseFlagValue(args, '--edited-since'),
    editedUntil: parseFlagValue(args, '--edited-until'),
    openedSince: parseFlagValue(args, '--opened-since'),
    openedUntil: parseFlagValue(args, '--opened-until'),
    createdSince: parseFlagValue(args, '--created-since'),
    createdUntil: parseFlagValue(args, '--created-until'),
    pageSize: parseFlagValue(args, '--page-size'),
    pageLimit: parseFlagValue(args, '--page-limit'),
    pageAll: args.includes('--page-all'),
    params: parseFlagValue(args, '--params'),
    mine: args.includes('--mine'),
    onlyTitle: args.includes('--only-title'),
    start: parseFlagValue(args, '--start') ?? positionals[1],
    end: parseFlagValue(args, '--end') ?? positionals[2],
    max: parseFlagValue(args, '--max'),
    mailbox: parseFlagValue(args, '--mailbox'),
    labels: args.includes('--labels'),
    complete,
    createdAt: parseFlagValue(args, '--created-at'),
    dueStart: parseFlagValue(args, '--due-start'),
    dueEnd: parseFlagValue(args, '--due-end'),
    timeRange: parseFlagValue(args, '--time-range') ?? positionals[0],
    userIdType: parseFlagValue(args, '--user-id-type'),
    cycleId: parseFlagValue(args, '--cycle-id') ?? positionals[0],
    targetId: parseFlagValue(args, '--target-id') ?? positionals[0],
    targetType: parseFlagValue(args, '--target-type') ?? positionals[1],
    departmentIdType: parseFlagValue(args, '--department-id-type'),
  };
}

function parseRefresh(args: string[]): RefreshOpts {
  const taskComplete = args.includes('--tasks-complete')
    ? true
    : args.includes('--tasks-all')
      ? undefined
      : false;
  return {
    path: parseFlagValue(args, '--path') ? expandPath(parseFlagValue(args, '--path')!) : undefined,
    sourceId: parseFlagValue(args, '--source-id') ?? 'feishu',
    sync: !args.includes('--no-sync'),
    noEmbed: !args.includes('--embed'),
    json: args.includes('--json'),
    agenda: !args.includes('--no-agenda'),
    tasks: !args.includes('--no-tasks'),
    taskQuery: parseFlagValue(args, '--task-query') ?? parseFlagValue(args, '--query'),
    taskComplete,
    dueStart: parseFlagValue(args, '--due-start'),
    dueEnd: parseFlagValue(args, '--due-end'),
    minutesQuery: parseFlagValue(args, '--minutes-query'),
    minutesStart: parseFlagValue(args, '--minutes-start') ?? parseFlagValue(args, '--start'),
    minutesEnd: parseFlagValue(args, '--minutes-end') ?? parseFlagValue(args, '--end'),
    driveQuery: parseFlagValue(args, '--drive-query'),
    driveDocTypes: parseFlagValue(args, '--drive-doc-types') ?? parseFlagValue(args, '--doc-types'),
    driveMine: args.includes('--drive-mine') || args.includes('--mine'),
    drivePageSize: parseFlagValue(args, '--drive-page-size') ?? parseFlagValue(args, '--page-size'),
    mailQuery: parseFlagValue(args, '--mail-query'),
    mailMax: parseFlagValue(args, '--mail-max'),
    mailLabels: args.includes('--mail-labels'),
    approvalTasks: args.includes('--approval-tasks'),
    approvalInitiated: args.includes('--approval-initiated'),
    approvalParams: parseFlagValue(args, '--approval-params') ?? parseFlagValue(args, '--params'),
    okrCycles: args.includes('--okr-cycles'),
    okrTimeRange: parseFlagValue(args, '--okr-time-range') ?? parseFlagValue(args, '--time-range'),
    okrUserId: parseFlagValue(args, '--okr-user-id') ?? parseFlagValue(args, '--user-id'),
    okrUserIdType: parseFlagValue(args, '--okr-user-id-type') ?? parseFlagValue(args, '--user-id-type'),
    okrCycleId: parseFlagValue(args, '--okr-cycle-id') ?? parseFlagValue(args, '--cycle-id'),
    baseToken: parseFlagValue(args, '--base-token'),
    baseTableId: parseFlagValue(args, '--base-table-id') ?? parseFlagValue(args, '--table-id'),
    baseViewId: parseFlagValue(args, '--base-view-id') ?? parseFlagValue(args, '--view-id'),
    baseFieldIds: parseRepeatedFlagValues(args, '--base-field-id').concat(parseRepeatedFlagValues(args, '--field-id')),
    baseSearchJson: parseFlagValue(args, '--base-search-json') ?? parseFlagValue(args, '--search-json'),
    baseLimit: parseFlagValue(args, '--base-limit') ?? parseFlagValue(args, '--limit'),
    baseOffset: parseFlagValue(args, '--base-offset') ?? parseFlagValue(args, '--offset'),
    baseTables: args.includes('--base-tables'),
    baseFields: args.includes('--base-fields'),
    baseRecords: args.includes('--base-records'),
    baseSearch: args.includes('--base-search'),
    imQuery: parseFlagValue(args, '--im-query'),
    imChatId: parseFlagValue(args, '--im-chat-id') ?? parseFlagValue(args, '--chat-id'),
    imUserId: parseFlagValue(args, '--im-user-id') ?? parseFlagValue(args, '--user-id'),
    imStart: parseFlagValue(args, '--im-start') ?? parseFlagValue(args, '--start'),
    imEnd: parseFlagValue(args, '--im-end') ?? parseFlagValue(args, '--end'),
    imPageSize: parseFlagValue(args, '--im-page-size') ?? parseFlagValue(args, '--page-size'),
    imPageLimit: parseFlagValue(args, '--im-page-limit') ?? parseFlagValue(args, '--page-limit'),
    imFlags: args.includes('--im-flags'),
    wikiSpaces: args.includes('--wiki-spaces'),
    wikiSpaceId: parseFlagValue(args, '--wiki-space-id'),
    wikiParentNodeToken: parseFlagValue(args, '--wiki-parent-node-token') ?? parseFlagValue(args, '--parent-node-token'),
    wikiPageSize: parseFlagValue(args, '--wiki-page-size'),
    wikiPageLimit: parseFlagValue(args, '--wiki-page-limit'),
    wikiPageAll: args.includes('--wiki-page-all'),
  };
}

function parseStatus(args: string[]): StatusOpts {
  return {
    path: parseFlagValue(args, '--path') ? expandPath(parseFlagValue(args, '--path')!) : undefined,
    sourceId: parseFlagValue(args, '--source-id') ?? 'feishu',
    json: args.includes('--json'),
  };
}

function parsePositiveIntFlag(args: string[], name: string): number | undefined {
  const raw = parseFlagValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseAilyPositionals(args: string[]): string[] {
  const valueFlags = new Set([
    '--path',
    '--source-id',
    '--host',
    '--space-id',
    '--knowledge-space-id',
    '--token-env',
    '--env-file',
    '--source-url-base',
    '--limit',
    '--registry',
    '--trigger',
    '--source-kind',
    '--name',
    '--base-token',
    '--base-table-id',
    '--base-as',
  ]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg) && i + 1 < args.length) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function normalizeAilyHost(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Aily host must be an http(s) URL: ${input}`);
  }
  return trimmed;
}

function parseAilyPushSpace(
  args: string[],
  env: EnvLookup = process.env,
  opts: { requireKnowledgeSpaceId?: boolean } = {},
): AilyPushSpaceOpts {
  const positionals = parseAilyPositionals(args);
  const knowledgeSpaceId =
    parseFlagValue(args, '--space-id') ??
    parseFlagValue(args, '--knowledge-space-id') ??
    positionals[0] ??
    env[AILY_DEFAULT_SPACE_ID_ENV] ??
    env[AILY_FALLBACK_SPACE_ID_ENV];
  if (!knowledgeSpaceId && opts.requireKnowledgeSpaceId !== false) {
    throw new Error(
      `Usage: ${brand()} feishu aily push-space --space-id <knowledge_space_xxx> ` +
      `[--path DIR] [--dry-run]\n` +
      `Or set ${AILY_DEFAULT_SPACE_ID_ENV}.`,
    );
  }

  return {
    path: parseFlagValue(args, '--path') ? expandPath(parseFlagValue(args, '--path')!) : undefined,
    sourceId: parseFlagValue(args, '--source-id') ?? 'feishu',
    host: normalizeAilyHost(parseFlagValue(args, '--host') ?? env.RBRAIN_AILY_HOST ?? env.AILY_HOST ?? AILY_DEFAULT_HOST),
    knowledgeSpaceId: knowledgeSpaceId ?? '',
    tokenEnv: parseFlagValue(args, '--token-env') ?? AILY_DEFAULT_TOKEN_ENV,
    envFile: parseFlagValue(args, '--env-file') ? expandPath(parseFlagValue(args, '--env-file')!) : undefined,
    sourceUrlBase: normalizeAilyHost(parseFlagValue(args, '--source-url-base') ?? AILY_DEFAULT_SOURCE_URL_BASE),
    limit: parsePositiveIntFlag(args, '--limit'),
    replace: args.includes('--replace'),
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
  };
}

function parseManagedSourceKind(input: string | undefined): ManagedSourceKind {
  if (
    input === 'doc' ||
    input === 'drive' ||
    input === 'wiki' ||
    input === 'im' ||
    input === 'base' ||
    input === 'manual'
  ) {
    return input;
  }
  if (input === undefined) return 'manual';
  throw new Error(`--source-kind must be one of doc, drive, wiki, im, base, manual`);
}

function parseManagedRegistryStoreKind(input: string | undefined): ManagedRegistryStoreKind {
  if (input === undefined || input === 'json') return 'json';
  if (input === 'postgres') return 'postgres';
  throw new Error(`--registry-store must be one of json, postgres`);
}

function resolveManagedRegistryFlags(
  args: string[],
  env: EnvLookup,
  opts: { requireRegistryUrl?: boolean; command: string },
): Pick<ManagedRegistryStatusOpts, 'registryPath' | 'registryStore' | 'registryUrl' | 'registryEnsureSchema'> {
  const registryUrl = parseFlagValue(args, '--registry-url') ?? env[MANAGED_REGISTRY_DATABASE_URL_ENV];
  const explicitStore = parseFlagValue(args, '--registry-store') ?? env[MANAGED_REGISTRY_STORE_ENV];
  const registryStore = parseManagedRegistryStoreKind(explicitStore ?? (registryUrl ? 'postgres' : 'json'));
  if (registryStore === 'postgres' && !registryUrl && opts.requireRegistryUrl !== false) {
    throw new Error(
      `${brand()} feishu managed ${opts.command} with --registry-store postgres requires --registry-url ` +
      `or ${MANAGED_REGISTRY_DATABASE_URL_ENV}.`,
    );
  }
  if (explicitStore === 'json' && registryUrl) {
    throw new Error(`${brand()} feishu managed ${opts.command} cannot combine --registry-store json with --registry-url.`);
  }
  return {
    registryPath: parseFlagValue(args, '--registry') ? expandPath(parseFlagValue(args, '--registry')!) : undefined,
    registryStore,
    registryUrl,
    registryEnsureSchema: args.includes('--registry-ensure-schema'),
  };
}

function parseManagedRegistryStatus(
  args: string[],
  env: EnvLookup = process.env,
  opts: { requireRegistryUrl?: boolean } = {},
): ManagedRegistryStatusOpts {
  return {
    path: parseFlagValue(args, '--path') ? expandPath(parseFlagValue(args, '--path')!) : undefined,
    sourceId: parseFlagValue(args, '--source-id') ?? 'feishu',
    ...resolveManagedRegistryFlags(args, env, { ...opts, command: 'status' }),
    json: args.includes('--json'),
  };
}

function parseManagedRegistryProvision(
  args: string[],
  env: EnvLookup = process.env,
): ManagedRegistryProvisionOpts {
  const flags = resolveManagedRegistryFlags(args, env, {
    command: 'provision-registry',
    requireRegistryUrl: false,
  });
  if (flags.registryStore !== 'postgres' || !flags.registryUrl) {
    throw new Error(
      `${brand()} feishu managed provision-registry requires --registry-url ` +
      `or ${MANAGED_REGISTRY_DATABASE_URL_ENV}.`,
    );
  }
  return {
    path: parseFlagValue(args, '--path') ? expandPath(parseFlagValue(args, '--path')!) : undefined,
    sourceId: parseFlagValue(args, '--source-id') ?? 'feishu',
    ...flags,
    registryStore: 'postgres',
    registryUrl: flags.registryUrl,
    registryEnsureSchema: true,
    json: args.includes('--json'),
  };
}

function parseManagedSync(
  args: string[],
  env: EnvLookup = process.env,
  opts: { requireKnowledgeSpaceId?: boolean; requireRegistryUrl?: boolean } = {},
): ManagedSyncOpts {
  const aily = parseAilyPushSpace(args, env, opts);
  return {
    ...aily,
    ...resolveManagedRegistryFlags(args, env, { ...opts, command: 'sync' }),
    trigger: parseFlagValue(args, '--trigger') ?? 'manual',
    sourceKind: parseManagedSourceKind(parseFlagValue(args, '--source-kind')),
    sourceName: parseFlagValue(args, '--name') ?? 'Feishu',
    baseToken: parseFlagValue(args, '--base-token'),
    baseTableId: parseFlagValue(args, '--base-table-id'),
    baseAs: parseFlagValue(args, '--base-as'),
  };
}

function parseManagedRefreshStatus(
  args: string[],
  env: EnvLookup = process.env,
  opts: { requireKnowledgeSpaceId?: boolean; requireRegistryUrl?: boolean } = {},
): ManagedRefreshStatusOpts {
  const aily = parseAilyPushSpace(args, env, opts);
  return {
    path: aily.path,
    sourceId: aily.sourceId,
    host: aily.host,
    knowledgeSpaceId: aily.knowledgeSpaceId,
    tokenEnv: aily.tokenEnv,
    dryRun: aily.dryRun,
    limit: aily.limit,
    ...resolveManagedRegistryFlags(args, env, { ...opts, command: 'refresh-status' }),
    baseToken: parseFlagValue(args, '--base-token'),
    baseTableId: parseFlagValue(args, '--base-table-id'),
    baseAs: parseFlagValue(args, '--base-as'),
    json: aily.json,
  };
}

function parseManagedWaitStatus(
  args: string[],
  env: EnvLookup = process.env,
  opts: { requireKnowledgeSpaceId?: boolean; requireRegistryUrl?: boolean } = {},
): ManagedWaitStatusOpts {
  const refresh = parseManagedRefreshStatus(args, env, opts);
  const targetStatus = parseFlagValue(args, '--target-status') ?? 'successful';
  if (!targetStatus.trim()) throw new Error('--target-status cannot be empty');
  return {
    ...refresh,
    targetStatus,
    timeoutMs: parsePositiveIntFlag(args, '--timeout-ms') ?? 300_000,
    intervalMs: parsePositiveIntFlag(args, '--interval-ms') ?? 15_000,
  };
}

function parseManagedBaseProvision(args: string[]): ManagedBaseProvisionOpts {
  return {
    baseToken: parseFlagValue(args, '--base-token'),
    tableName: parseFlagValue(args, '--table-name') ?? parseFlagValue(args, '--name') ?? 'RBrain Managed Assets',
    as: parseFlagValue(args, '--as'),
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
  };
}

export interface ManagedRegistryStoreConfig {
  kind: ManagedRegistryStoreKind;
  registryPath: string;
  location: string;
  postgresUrl?: string;
  ensureSchema: boolean;
}

export interface ManagedRegistryStoreHandle {
  store: ManagedRegistryStore;
  close?: () => Promise<void>;
}

export type ManagedPostgresSqlClient = ManagedRegistrySqlClient & { end?: () => Promise<unknown> };
export type ManagedPostgresFactory = (url: string) => ManagedPostgresSqlClient;

export function resolveManagedRegistryStoreConfig(opts: {
  kind: ManagedRegistryStoreKind;
  root: string;
  registryPath?: string;
  registryUrl?: string;
  ensureSchema: boolean;
}): ManagedRegistryStoreConfig {
  const registryPath = opts.registryPath ?? defaultManagedRegistryPath(opts.root);
  if (opts.kind === 'json') {
    return {
      kind: 'json',
      registryPath,
      location: registryPath,
      ensureSchema: false,
    };
  }
  if (!opts.registryUrl) {
    throw new Error(`${brand()} feishu managed registry with postgres store needs a database URL.`);
  }
  return {
    kind: 'postgres',
    registryPath,
    location: redactPgUrl(opts.registryUrl),
    postgresUrl: opts.registryUrl,
    ensureSchema: opts.ensureSchema,
  };
}

function createManagedPostgresSqlClient(url: string): ManagedPostgresSqlClient {
  const prepare = resolvePrepare(url);
  const timeouts = resolveSessionTimeouts();
  const clientOpts: Record<string, unknown> = {
    max: resolvePoolSize(),
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      bigint: postgres.BigInt,
    },
    onnotice: process.env.GBRAIN_PG_NOTICES === '1' ? undefined : () => {},
  };
  if (Object.keys(timeouts).length > 0) clientOpts.connection = timeouts;
  if (typeof prepare === 'boolean') clientOpts.prepare = prepare;
  return postgres(url, clientOpts) as unknown as ManagedPostgresSqlClient;
}

export async function createManagedRegistryStoreHandle(
  config: ManagedRegistryStoreConfig,
  postgresFactory: ManagedPostgresFactory = createManagedPostgresSqlClient,
): Promise<ManagedRegistryStoreHandle> {
  if (config.kind === 'json') {
    return { store: createJsonManagedRegistryStore(config.registryPath) };
  }

  const sql = postgresFactory(config.postgresUrl!);
  const store = createPostgresManagedRegistryStore(sql, config.location);
  if (config.ensureSchema) await store.ensureSchema();
  return {
    store,
    close: async () => {
      await sql.end?.();
    },
  };
}

async function resolveManagedRegistryRoot(
  engine: BrainEngine | undefined,
  opts: { sourceId: string; path?: string; registryStore: ManagedRegistryStoreKind },
  command: string,
): Promise<string> {
  if (opts.path) return opts.path;
  if (engine) return resolveMirrorRoot(engine, opts);
  if (opts.registryStore === 'postgres') return process.cwd();
  throw new Error(`${brand()} feishu managed ${command} needs --path DIR when no local RBrain database is connected.`);
}

function parseJsonObject(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

function parseDotEnv(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0]!;
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

function readDotEnv(path: string | undefined): Record<string, string> {
  if (!path || !existsSync(path)) return {};
  return parseDotEnv(readFileSync(path, 'utf-8'));
}

function loadAilyEnv(args: string[], root?: string): EnvLookup {
  const initialEnvFile = parseFlagValue(args, '--env-file');
  const explicitEnvFile = initialEnvFile ? expandPath(initialEnvFile) : undefined;
  return {
    ...(root ? readDotEnv(join(root, '.env')) : {}),
    ...readDotEnv(join(process.cwd(), '.env')),
    ...readDotEnv(explicitEnvFile),
    ...process.env,
  };
}

function runLocalCommand(
  argv: readonly string[],
  opts: { cwd?: string; timeout?: number } = {},
): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 15_000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const asDate = new Date(String(value));
  return Number.isNaN(asDate.getTime()) ? String(value) : asDate.toISOString();
}

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countMarkdownFiles(path);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      count += 1;
    }
  }
  return count;
}

function latestMarkdownFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let latest: { path: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = latestMarkdownFile(path);
      if (!nested) continue;
      const stat = statSync(nested);
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { path: nested, mtimeMs: stat.mtimeMs };
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = statSync(path);
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { path, mtimeMs: stat.mtimeMs };
    }
  }
  return latest?.path ?? null;
}

function inspectMirrorGit(root: string | null): MirrorGitInspection {
  if (!root || !existsSync(root) || !existsSync(join(root, '.git'))) {
    return { state: 'missing', head: null, dirty_files: 0 };
  }
  if (!gitAvailable()) {
    return { state: 'unavailable', head: null, dirty_files: 0, error: 'git is not available on PATH' };
  }

  const status = runLocalCommand(['git', 'status', '--porcelain'], { cwd: root });
  if (!status.ok) {
    return {
      state: 'failed',
      head: null,
      dirty_files: 0,
      error: status.stderr || status.stdout || `git status exited ${status.status}`,
    };
  }
  const head = runLocalCommand(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root });
  const dirtyFiles = status.stdout ? status.stdout.split('\n').filter(Boolean).length : 0;
  return {
    state: dirtyFiles > 0 ? 'dirty' : 'clean',
    head: head.ok ? head.stdout : null,
    dirty_files: dirtyFiles,
  };
}

function gitAvailable(): boolean {
  return runLocalCommand(['git', '--version']).ok;
}

function ensureGitIdentity(root: string): void {
  if (!runLocalCommand(['git', 'config', 'user.name'], { cwd: root }).ok) {
    runLocalCommand(['git', 'config', 'user.name', 'RBrain Feishu Mirror'], { cwd: root });
  }
  if (!runLocalCommand(['git', 'config', 'user.email'], { cwd: root }).ok) {
    runLocalCommand(['git', 'config', 'user.email', 'rbrain-feishu@local'], { cwd: root });
  }
}

function ensureGitRepository(root: string, enabled: boolean): MirrorGitStatus {
  if (!enabled) return { repository: 'skipped', commit: 'skipped' };
  if (!gitAvailable()) {
    return {
      repository: 'unavailable',
      commit: 'skipped',
      error: 'git is not available on PATH',
    };
  }

  const hadGit = existsSync(join(root, '.git'));
  if (!hadGit) {
    const init = runLocalCommand(['git', 'init'], { cwd: root });
    if (!init.ok) {
      return {
        repository: 'failed',
        commit: 'skipped',
        error: init.stderr || init.stdout || `git init exited ${init.status}`,
      };
    }
  }

  ensureGitIdentity(root);
  runLocalCommand(['git', 'add', 'README.md', '.gitignore', '.env.aily.example', 'feishu', 'scripts'], { cwd: root });
  const staged = runLocalCommand(['git', 'diff', '--cached', '--quiet'], { cwd: root });
  if (staged.ok) {
    return { repository: hadGit ? 'existing' : 'initialized', commit: 'clean' };
  }

  const commit = runLocalCommand(['git', 'commit', '-m', 'rbrain: initialize feishu mirror'], { cwd: root });
  if (!commit.ok) {
    return {
      repository: hadGit ? 'existing' : 'initialized',
      commit: 'failed',
      error: commit.stderr || commit.stdout || `git commit exited ${commit.status}`,
    };
  }
  return { repository: hadGit ? 'existing' : 'initialized', commit: 'created' };
}

function commitSnapshot(root: string, path: string, message: string): MirrorGitStatus['commit'] {
  if (!gitAvailable() || !existsSync(join(root, '.git'))) return 'skipped';
  ensureGitIdentity(root);
  runLocalCommand(['git', 'add', path], { cwd: root });
  const staged = runLocalCommand(['git', 'diff', '--cached', '--quiet', '--', path], { cwd: root });
  if (staged.ok) return 'clean';
  const commit = runLocalCommand(['git', 'commit', '-m', message], { cwd: root });
  return commit.ok ? 'created' : 'failed';
}

function slugForDoc(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function tokenFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export function normalizeDocSlug(input: string): string {
  const cleaned = input
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 96);
  if (!cleaned) return `doc-${slugForDoc(input)}`;
  return cleaned;
}

function looksLikeDocRef(input: string): boolean {
  return (
    /^https?:\/\//i.test(input) ||
    /(?:feishu|larksuite)\.cn/i.test(input) ||
    /^(docx?|doccn|doxcn|wiki|wikcn|sht|shtcn|bitable|base|fld|file|omin)[A-Za-z0-9_-]{6,}/i.test(input)
  );
}

export function parseDocManifest(input: string): DocManifestEntry[] {
  const entries: DocManifestEntry[] = [];
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;

    const columns = line.includes('\t')
      ? line.split('\t')
      : line.includes(',')
        ? line.split(',')
        : line.split(/\s+/);
    const parts = columns.map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length === 1) {
      entries.push({ doc: parts[0]!, line: i + 1 });
      continue;
    }

    const [first, second] = parts as [string, string, ...string[]];
    const firstIsDoc = looksLikeDocRef(first);
    const secondIsDoc = looksLikeDocRef(second);
    if (secondIsDoc && !firstIsDoc) {
      entries.push({ doc: second, slug: normalizeDocSlug(first), line: i + 1 });
    } else {
      entries.push({ doc: first, slug: normalizeDocSlug(second), line: i + 1 });
    }
  }
  return entries;
}

function codeFence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``;
}

type FeishuFrontmatter = Record<string, string | boolean>;

function buildFeishuMarkdown(frontmatter: FeishuFrontmatter, heading: string, rawJson: string): string {
  const yaml = matter.stringify('', frontmatter).trim();
  return `${yaml}

# ${heading}

${codeFence('json', rawJson)}
`;
}

export function buildAgendaMarkdown(day: string, rawJson: string): string {
  return buildFeishuMarkdown({
    type: 'feishu-calendar',
    title: `Feishu Agenda ${day}`,
    captured_via: 'lark-cli',
    source_command: 'lark-cli calendar +agenda --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Agenda ${day}`, rawJson);
}

export function buildDocMarkdown(slug: string, doc: string, rawJson: string): string {
  return buildFeishuMarkdown({
    type: 'feishu-doc',
    title: `Feishu Doc ${slug}`,
    feishu_url: doc,
    captured_via: 'lark-cli',
    source_command: 'lark-cli docs +fetch --api-version v2 --doc <redacted> --doc-format markdown --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Doc ${slug}`, rawJson);
}

export function buildDriveSearchMarkdown(
  stamp: string,
  opts: {
    query?: string;
    docTypes?: string;
    spaceIds?: string;
    folderTokens?: string;
    sort?: string;
    editedSince?: string;
    editedUntil?: string;
    openedSince?: string;
    openedUntil?: string;
    createdSince?: string;
    createdUntil?: string;
    pageSize?: string;
    mine?: boolean;
    onlyTitle?: boolean;
  },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-drive',
    title: `Feishu Drive Search ${stamp}`,
    query: opts.query ?? '',
    doc_types: opts.docTypes ?? '',
    space_ids: opts.spaceIds ?? '',
    folder_tokens: opts.folderTokens ?? '',
    sort: opts.sort ?? '',
    edited_since: opts.editedSince ?? '',
    edited_until: opts.editedUntil ?? '',
    opened_since: opts.openedSince ?? '',
    opened_until: opts.openedUntil ?? '',
    created_since: opts.createdSince ?? '',
    created_until: opts.createdUntil ?? '',
    page_size: opts.pageSize ?? '15',
    mine: Boolean(opts.mine),
    only_title: Boolean(opts.onlyTitle),
    captured_via: 'lark-cli',
    source_command: 'lark-cli drive +search --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Drive Search ${stamp}`, rawJson);
}

export function buildWikiSpacesMarkdown(
  stamp: string,
  opts: { pageSize?: string; pageLimit?: string; pageAll?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-wiki',
    title: `Feishu Wiki Spaces ${stamp}`,
    wiki_scope: 'spaces',
    page_size: opts.pageSize ?? '50',
    page_all: Boolean(opts.pageAll),
    page_limit: opts.pageLimit ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli wiki +space-list --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Wiki Spaces ${stamp}`, rawJson);
}

export function buildWikiNodesMarkdown(
  stamp: string,
  opts: { spaceId?: string; parentNodeToken?: string; pageSize?: string; pageLimit?: string; pageAll?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-wiki',
    title: `Feishu Wiki Nodes ${stamp}`,
    wiki_scope: 'nodes',
    space_id: opts.spaceId ?? 'my_library',
    parent_node_token: opts.parentNodeToken ?? '',
    page_size: opts.pageSize ?? '50',
    page_all: Boolean(opts.pageAll),
    page_limit: opts.pageLimit ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli wiki +node-list --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Wiki Nodes ${stamp}`, rawJson);
}

export function buildMinutesSearchMarkdown(
  stamp: string,
  opts: { query?: string; start?: string; end?: string },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-minutes',
    title: `Feishu Minutes Search ${stamp}`,
    query: opts.query ?? '',
    start: opts.start ?? '',
    end: opts.end ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli minutes +search --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Minutes Search ${stamp}`, rawJson);
}

export function buildMailTriageMarkdown(
  stamp: string,
  opts: { query?: string; filter?: string; max?: string; mailbox?: string; labels?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-mail',
    title: `Feishu Mail Triage ${stamp}`,
    query: opts.query ?? '',
    filter: opts.filter ?? '',
    mailbox: opts.mailbox ?? 'me',
    max: opts.max ?? '20',
    labels: Boolean(opts.labels),
    captured_via: 'lark-cli',
    source_command: 'lark-cli mail +triage --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Mail Triage ${stamp}`, rawJson);
}

export function buildBaseTablesMarkdown(
  stamp: string,
  opts: { baseToken?: string; limit?: string; offset?: string },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-base',
    title: `Feishu Base Tables ${stamp}`,
    base_scope: 'tables',
    base_token_hash: opts.baseToken ? tokenFingerprint(opts.baseToken) : '',
    limit: opts.limit ?? '50',
    offset: opts.offset ?? '0',
    captured_via: 'lark-cli',
    source_command: 'lark-cli base +table-list --base-token <redacted>',
    captured_at: new Date().toISOString(),
  }, `Feishu Base Tables ${stamp}`, rawJson);
}

export function buildBaseFieldsMarkdown(
  stamp: string,
  opts: { baseToken?: string; tableId?: string; limit?: string; offset?: string },
  rawJson: string,
): string {
  const heading = `Feishu Base Fields ${opts.tableId ?? ''} ${stamp}`;
  return buildFeishuMarkdown({
    type: 'feishu-base',
    title: heading,
    base_scope: 'fields',
    base_token_hash: opts.baseToken ? tokenFingerprint(opts.baseToken) : '',
    table_id: opts.tableId ?? '',
    limit: opts.limit ?? '100',
    offset: opts.offset ?? '0',
    captured_via: 'lark-cli',
    source_command: 'lark-cli base +field-list --base-token <redacted>',
    captured_at: new Date().toISOString(),
  }, heading, rawJson);
}

export function buildBaseRecordsMarkdown(
  stamp: string,
  opts: { baseToken?: string; tableId?: string; viewId?: string; fieldIds?: string[]; limit?: string; offset?: string },
  rawJson: string,
): string {
  const heading = `Feishu Base Records ${opts.tableId ?? ''} ${stamp}`;
  return buildFeishuMarkdown({
    type: 'feishu-base',
    title: heading,
    base_scope: 'records',
    base_token_hash: opts.baseToken ? tokenFingerprint(opts.baseToken) : '',
    table_id: opts.tableId ?? '',
    view_id: opts.viewId ?? '',
    field_ids: opts.fieldIds?.join(',') ?? '',
    limit: opts.limit ?? '100',
    offset: opts.offset ?? '0',
    captured_via: 'lark-cli',
    source_command: 'lark-cli base +record-list --format json --base-token <redacted>',
    captured_at: new Date().toISOString(),
  }, heading, rawJson);
}

export function buildBaseSearchMarkdown(
  stamp: string,
  opts: { baseToken?: string; tableId?: string; viewId?: string; searchJson?: string },
  rawJson: string,
): string {
  const heading = `Feishu Base Search ${opts.tableId ?? ''} ${stamp}`;
  return buildFeishuMarkdown({
    type: 'feishu-base',
    title: heading,
    base_scope: 'search',
    base_token_hash: opts.baseToken ? tokenFingerprint(opts.baseToken) : '',
    table_id: opts.tableId ?? '',
    view_id: opts.viewId ?? '',
    search_json: opts.searchJson ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli base +record-search --format json --base-token <redacted>',
    captured_at: new Date().toISOString(),
  }, heading, rawJson);
}

export function buildImChatListMarkdown(
  stamp: string,
  opts: { types?: string; sortType?: string; pageSize?: string; excludeMuted?: boolean; userIdType?: string },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-im',
    title: `Feishu IM Chat List ${stamp}`,
    im_scope: 'chat-list',
    types: opts.types ?? 'group',
    sort_type: opts.sortType ?? 'ByCreateTimeAsc',
    page_size: opts.pageSize ?? '20',
    exclude_muted: Boolean(opts.excludeMuted),
    user_id_type: opts.userIdType ?? 'open_id',
    captured_via: 'lark-cli',
    source_command: 'lark-cli im +chat-list --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu IM Chat List ${stamp}`, rawJson);
}

export function buildImChatSearchMarkdown(
  stamp: string,
  opts: { query?: string; memberIds?: string; searchTypes?: string; sortBy?: string; pageSize?: string; excludeMuted?: boolean; isManager?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-im',
    title: `Feishu IM Chat Search ${stamp}`,
    im_scope: 'chat-search',
    query: opts.query ?? '',
    member_ids: opts.memberIds ?? '',
    search_types: opts.searchTypes ?? '',
    sort_by: opts.sortBy ?? '',
    page_size: opts.pageSize ?? '20',
    exclude_muted: Boolean(opts.excludeMuted),
    is_manager: Boolean(opts.isManager),
    captured_via: 'lark-cli',
    source_command: 'lark-cli im +chat-search --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu IM Chat Search ${stamp}`, rawJson);
}

export function buildImChatMessagesMarkdown(
  stamp: string,
  opts: { chatId?: string; userId?: string; start?: string; end?: string; sort?: string; pageSize?: string; noReactions?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-im',
    title: `Feishu IM Chat Messages ${stamp}`,
    im_scope: 'chat-messages',
    chat_id: opts.chatId ?? '',
    user_id: opts.userId ?? '',
    start: opts.start ?? '',
    end: opts.end ?? '',
    sort: opts.sort ?? 'desc',
    page_size: opts.pageSize ?? '50',
    no_reactions: Boolean(opts.noReactions),
    captured_via: 'lark-cli',
    source_command: 'lark-cli im +chat-messages-list --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu IM Chat Messages ${stamp}`, rawJson);
}

export function buildImMessageSearchMarkdown(
  stamp: string,
  opts: {
    query?: string;
    chatId?: string;
    chatType?: string;
    sender?: string;
    senderType?: string;
    excludeSenderType?: string;
    atChatterIds?: string;
    includeAttachmentType?: string;
    start?: string;
    end?: string;
    pageSize?: string;
    pageLimit?: string;
    pageAll?: boolean;
    isAtMe?: boolean;
    noReactions?: boolean;
  },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-im',
    title: `Feishu IM Message Search ${stamp}`,
    im_scope: 'message-search',
    query: opts.query ?? '',
    chat_id: opts.chatId ?? '',
    chat_type: opts.chatType ?? '',
    sender: opts.sender ?? '',
    sender_type: opts.senderType ?? '',
    exclude_sender_type: opts.excludeSenderType ?? '',
    at_chatter_ids: opts.atChatterIds ?? '',
    include_attachment_type: opts.includeAttachmentType ?? '',
    start: opts.start ?? '',
    end: opts.end ?? '',
    page_size: opts.pageSize ?? '20',
    page_all: Boolean(opts.pageAll),
    page_limit: opts.pageLimit ?? '',
    is_at_me: Boolean(opts.isAtMe),
    no_reactions: Boolean(opts.noReactions),
    captured_via: 'lark-cli',
    source_command: 'lark-cli im +messages-search --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu IM Message Search ${stamp}`, rawJson);
}

export function buildImFlagsMarkdown(
  stamp: string,
  opts: { pageSize?: string; pageLimit?: string; pageAll?: boolean; enrichFeedThread?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-im',
    title: `Feishu IM Flags ${stamp}`,
    im_scope: 'flags',
    page_size: opts.pageSize ?? '50',
    page_all: Boolean(opts.pageAll),
    page_limit: opts.pageLimit ?? '',
    enrich_feed_thread: opts.enrichFeedThread !== false,
    captured_via: 'lark-cli',
    source_command: 'lark-cli im +flag-list --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu IM Flags ${stamp}`, rawJson);
}

export function buildApprovalTasksMarkdown(
  stamp: string,
  opts: { params?: string; pageLimit?: string; pageAll?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-approval',
    title: `Feishu Approval Tasks ${stamp}`,
    approval_scope: 'tasks',
    params: opts.params ?? '',
    page_all: Boolean(opts.pageAll),
    page_limit: opts.pageLimit ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli approval tasks query --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Approval Tasks ${stamp}`, rawJson);
}

export function buildApprovalInitiatedMarkdown(
  stamp: string,
  opts: { params?: string; pageLimit?: string; pageAll?: boolean },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-approval',
    title: `Feishu Approval Initiated ${stamp}`,
    approval_scope: 'initiated',
    params: opts.params ?? '',
    page_all: Boolean(opts.pageAll),
    page_limit: opts.pageLimit ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli approval instances initiated --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu Approval Initiated ${stamp}`, rawJson);
}

export function buildOkrCyclesMarkdown(
  stamp: string,
  opts: { timeRange?: string; userId?: string; userIdType?: string },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-okr',
    title: `Feishu OKR Cycles ${stamp}`,
    okr_scope: 'cycles',
    time_range: opts.timeRange ?? '',
    user_id: opts.userId ?? '',
    user_id_type: opts.userIdType ?? 'open_id',
    captured_via: 'lark-cli',
    source_command: 'lark-cli okr +cycle-list --format json',
    captured_at: new Date().toISOString(),
  }, `Feishu OKR Cycles ${stamp}`, rawJson);
}

export function buildOkrCycleDetailMarkdown(
  stamp: string,
  opts: { cycleId?: string },
  rawJson: string,
): string {
  const heading = `Feishu OKR Cycle ${opts.cycleId ?? ''} ${stamp}`;
  return buildFeishuMarkdown({
    type: 'feishu-okr',
    title: heading,
    okr_scope: 'cycle-detail',
    cycle_id: opts.cycleId ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli okr +cycle-detail --format json',
    captured_at: new Date().toISOString(),
  }, heading, rawJson);
}

export function buildTasksMarkdown(
  day: string,
  opts: { query?: string; complete?: boolean; createdAt?: string; dueStart?: string; dueEnd?: string },
  rawJson: string,
): string {
  return buildFeishuMarkdown({
    type: 'feishu-task',
    title: `Feishu Tasks ${day}`,
    query: opts.query ?? '',
    complete: opts.complete === undefined ? '' : opts.complete,
    created_at: opts.createdAt ?? '',
    due_start: opts.dueStart ?? '',
    due_end: opts.dueEnd ?? '',
    captured_via: 'lark-cli',
    source_command: 'lark-cli task +get-my-tasks --format json --page-all',
    captured_at: new Date().toISOString(),
  }, `Feishu Tasks ${day}`, rawJson);
}

export function buildAutoCommitShellFunction(): string {
  return `yaml_scalar() {
  local value="\${1-}"
  value="\${value//\\\\/\\\\\\\\}"
  value="\${value//\\"/\\\\\\"}"
  value="\${value//$'\\n'/\\\\n}"
  value="\${value//$'\\r'/\\\\r}"
  printf '"%s"' "$value"
}

yaml_kv() {
  local key="$1"
  local value="\${2-}"
  printf '%s: %s\\n' "$key" "$(yaml_scalar "$value")"
}

yaml_bool_kv() {
  local key="$1"
  local value="\${2-}"
  case "$value" in
    1|true|TRUE|yes|YES) printf '%s: true\\n' "$key" ;;
    *) printf '%s: false\\n' "$key" ;;
  esac
}

commit_snapshot() {
  local path="$1"
  local message="$2"
  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi
  if [ ! -d "$ROOT/.git" ]; then
    return 0
  fi
  git -C "$ROOT" config user.name >/dev/null 2>&1 || git -C "$ROOT" config user.name "RBrain Feishu Mirror"
  git -C "$ROOT" config user.email >/dev/null 2>&1 || git -C "$ROOT" config user.email "rbrain-feishu@local"
  git -C "$ROOT" add "$path"
  if git -C "$ROOT" diff --cached --quiet -- "$path"; then
    return 0
  fi
  git -C "$ROOT" commit -m "$message" >/dev/null 2>&1 || true
}
`;
}

export function buildMirrorReadme(root: string): string {
  return `# RBrain Feishu Mirror

This folder is the local Feishu mirror for RBrain.

Feishu remains the collaboration and permission surface. This mirror keeps
deterministic markdown snapshots that RBrain can sync, embed, cite, and connect.

## Layout

- feishu/docs/       Cloud docs and docx exports
- feishu/drive/      Drive and Wiki search/discovery snapshots
- feishu/wiki/       Wiki spaces and canonical pages
- feishu/minutes/    Minutes summaries, chapters, transcripts, and action items
- feishu/calendar/   Daily agenda snapshots
- feishu/tasks/      Tasks and follow-ups
- feishu/im/         Selected chats and threads
- feishu/mail/       Mail digests
- feishu/base/       Base, Bitable, and Sheets exports
- feishu/approvals/  Approval decisions and workflow records
- feishu/okr/        OKR snapshots

## First Commands

\`\`\`bash
${brand()} feishu setup --path "${root}"
\`\`\`

Run \`scripts/pull-feishu-agenda.sh\` after \`lark-cli doctor\` passes.
Run \`scripts/pull-feishu-tasks.sh\` to snapshot tasks assigned to you.
Add document URLs or tokens to \`feishu/docs/docs-list.tsv\`, then run
\`scripts/pull-feishu-docs-list.sh\` to snapshot a working set of Feishu docs.
Run \`scripts/pull-feishu-drive-search.sh\` to discover relevant Feishu docs and Wiki pages.
Run \`scripts/pull-feishu-wiki-spaces.sh\` and \`scripts/pull-feishu-wiki-nodes.sh\`
to map Wiki spaces and node trees.
Run \`scripts/pull-feishu-mail-triage.sh\` to snapshot recent Feishu Mail summaries.
Run \`scripts/pull-feishu-okr-cycles.sh\` and \`scripts/pull-feishu-approval-tasks.sh\`
to capture OKR and approval workflow context.
Run \`scripts/pull-feishu-base-tables.sh\`, \`scripts/pull-feishu-base-fields.sh\`,
and \`scripts/pull-feishu-base-records.sh\` to capture read-only Base data.
Run \`scripts/pull-feishu-im-message-search.sh\` and
\`scripts/pull-feishu-im-chat-messages.sh\` to capture selected chat context.
Run \`scripts/refresh-feishu.sh\` for the daily agenda + tasks refresh.
Collection scripts commit each new snapshot locally so \`${brand()} sync --source feishu\`
can import the latest Feishu state.

To use Aily as the managed knowledge backend, push committed mirror snapshots
into a knowledge space:

\`\`\`bash
${brand()} feishu aily push-space --space-id knowledge_space_xxx --dry-run
${AILY_DEFAULT_TOKEN_ENV}=... ${brand()} feishu aily push-space --space-id knowledge_space_xxx
\`\`\`

For local use, copy \`.env.aily.example\` to \`.env\` and fill in the real
knowledge-space values. \`.env\` is ignored by this mirror's Git repo.
`;
}

export function buildMirrorGitignore(): string {
  return `.env
.env.*
!.env.*.example
.rbrain-managed/
.DS_Store
*.log
`;
}

export function buildAilyEnvExample(): string {
  return `# Copy this file to .env and fill in real values.
# .env is ignored by the generated Feishu mirror Git repository.
RBRAIN_AILY_KNOWLEDGE_SPACE_ID=knowledge_space_xxx
RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN=
# RBRAIN_AILY_HOST=https://apaas.feishu.cn
`;
}

export function buildAgendaScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
OUT_DIR="$ROOT/feishu/calendar"
DAY="$(date +%F)"
OUT="$OUT_DIR/$DAY.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli calendar +agenda --format json >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-calendar"
  yaml_kv title "Feishu Agenda $DAY"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli calendar +agenda --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Agenda $DAY"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Run \`lark-cli doctor\` and retry."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update agenda $DAY"
echo "Wrote $OUT"
`;
}

export function buildDocScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
DOC="\${1:-}"
SLUG="\${2:-}"

if [ -z "$DOC" ]; then
  echo "Usage: $0 <feishu-doc-url-or-token> [slug]" >&2
  exit 2
fi

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

if [ -z "$SLUG" ]; then
  SLUG="$(echo "$DOC" | shasum -a 256 | cut -c1-12)"
fi

OUT_DIR="$ROOT/feishu/docs"
OUT="$OUT_DIR/$SLUG.md"
mkdir -p "$OUT_DIR"

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli docs +fetch --api-version v2 --doc "$DOC" --doc-format markdown --format json >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-doc"
  yaml_kv title "Feishu Doc $SLUG"
  yaml_kv feishu_url "$DOC"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli docs +fetch --api-version v2 --doc <redacted> --doc-format markdown --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Doc $SLUG"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check document permissions and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update doc $SLUG"
echo "Wrote $OUT"
`;
}

export function buildDocListManifestTemplate(): string {
  return `# Feishu document manifest for RBrain.
# One document per line. Supported forms:
#   <feishu-doc-url-or-token>
#   <feishu-doc-url-or-token><TAB><slug>
#   <slug><TAB><feishu-doc-url-or-token>
#
# Example:
# https://example.feishu.cn/docx/xxxx	product-review
`;
}

export function buildDocListScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
RBRAIN_BIN="\${RBRAIN_BIN:-${brand()}}"
SOURCE_ID="\${RBRAIN_SOURCE_ID:-feishu}"
FILE="\${1:-$ROOT/feishu/docs/docs-list.tsv}"
if [ "$#" -gt 0 ]; then
  shift
fi

if ! command -v "$RBRAIN_BIN" >/dev/null 2>&1; then
  echo "$RBRAIN_BIN not found. Set RBRAIN_BIN to your rbrain executable." >&2
  exit 127
fi

exec "$RBRAIN_BIN" feishu pull docs-list --path "$ROOT" --source-id "$SOURCE_ID" --file "$FILE" "$@"
`;
}

export function buildDriveSearchScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
QUERY="\${1:-}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/drive"
OUT="$OUT_DIR/search-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(drive +search --format json --page-size "\${DRIVE_PAGE_SIZE:-15}")
if [ -n "$QUERY" ]; then ARGS+=(--query "$QUERY"); fi
if [ -n "\${DRIVE_DOC_TYPES:-}" ]; then ARGS+=(--doc-types "$DRIVE_DOC_TYPES"); fi
if [ -n "\${DRIVE_SPACE_IDS:-}" ]; then ARGS+=(--space-ids "$DRIVE_SPACE_IDS"); fi
if [ -n "\${DRIVE_FOLDER_TOKENS:-}" ]; then ARGS+=(--folder-tokens "$DRIVE_FOLDER_TOKENS"); fi
if [ -n "\${DRIVE_SORT:-}" ]; then ARGS+=(--sort "$DRIVE_SORT"); fi
if [ -n "\${DRIVE_EDITED_SINCE:-}" ]; then ARGS+=(--edited-since "$DRIVE_EDITED_SINCE"); fi
if [ -n "\${DRIVE_OPENED_SINCE:-}" ]; then ARGS+=(--opened-since "$DRIVE_OPENED_SINCE"); fi
if [ -n "\${DRIVE_CREATED_SINCE:-}" ]; then ARGS+=(--created-since "$DRIVE_CREATED_SINCE"); fi
if [ "\${DRIVE_MINE:-0}" = "1" ]; then ARGS+=(--mine); fi
if [ "\${DRIVE_ONLY_TITLE:-0}" = "1" ]; then ARGS+=(--only-title); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-drive"
  yaml_kv title "Feishu Drive Search $STAMP"
  yaml_kv query "$QUERY"
  yaml_kv doc_types "\${DRIVE_DOC_TYPES:-}"
  yaml_kv sort "\${DRIVE_SORT:-}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli drive +search --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Drive Search $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Drive access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update drive search $STAMP"
echo "Wrote $OUT"
`;
}

export function buildWikiSpacesScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/wiki"
OUT="$OUT_DIR/spaces-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(wiki +space-list --format json --page-size "\${WIKI_PAGE_SIZE:-50}")
if [ "\${WIKI_PAGE_ALL:-0}" = "1" ]; then
  ARGS+=(--page-all --page-limit "\${WIKI_PAGE_LIMIT:-10}")
fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-wiki"
  yaml_kv title "Feishu Wiki Spaces $STAMP"
  echo "wiki_scope: spaces"
  yaml_kv page_size "\${WIKI_PAGE_SIZE:-50}"
  yaml_bool_kv page_all "\${WIKI_PAGE_ALL:-0}"
  yaml_kv page_limit "\${WIKI_PAGE_LIMIT:-10}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli wiki +space-list --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Wiki Spaces $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Wiki access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update wiki spaces $STAMP"
echo "Wrote $OUT"
`;
}

export function buildWikiNodesScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
SPACE_ID="\${1:-my_library}"
PARENT_NODE_TOKEN="\${2:-}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
SAFE_SPACE="$(printf '%s' "$SPACE_ID" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-96)"
if [ -z "$SAFE_SPACE" ]; then SAFE_SPACE="my_library"; fi
OUT_DIR="$ROOT/feishu/wiki"
OUT="$OUT_DIR/nodes-$SAFE_SPACE-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(wiki +node-list --format json --space-id "$SPACE_ID" --page-size "\${WIKI_PAGE_SIZE:-50}")
if [ -n "$PARENT_NODE_TOKEN" ]; then ARGS+=(--parent-node-token "$PARENT_NODE_TOKEN"); fi
if [ "\${WIKI_PAGE_ALL:-0}" = "1" ]; then
  ARGS+=(--page-all --page-limit "\${WIKI_PAGE_LIMIT:-10}")
fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-wiki"
  yaml_kv title "Feishu Wiki Nodes $STAMP"
  echo "wiki_scope: nodes"
  yaml_kv space_id "$SPACE_ID"
  yaml_kv parent_node_token "$PARENT_NODE_TOKEN"
  yaml_kv page_size "\${WIKI_PAGE_SIZE:-50}"
  yaml_bool_kv page_all "\${WIKI_PAGE_ALL:-0}"
  yaml_kv page_limit "\${WIKI_PAGE_LIMIT:-10}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli wiki +node-list --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Wiki Nodes $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Wiki access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update wiki nodes $STAMP"
echo "Wrote $OUT"
`;
}

export function buildMinutesSearchScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
QUERY="\${1:-}"
START="\${2:-}"
END="\${3:-}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/minutes"
OUT="$OUT_DIR/search-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(minutes +search --format json)
if [ -n "$QUERY" ]; then ARGS+=(--query "$QUERY"); fi
if [ -n "$START" ]; then ARGS+=(--start "$START"); fi
if [ -n "$END" ]; then ARGS+=(--end "$END"); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-minutes"
  yaml_kv title "Feishu Minutes Search $STAMP"
  yaml_kv query "$QUERY"
  yaml_kv start "$START"
  yaml_kv end "$END"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli minutes +search --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Minutes Search $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check minutes access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update minutes search $STAMP"
echo "Wrote $OUT"
`;
}

export function buildMailTriageScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
QUERY="\${1:-}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/mail"
OUT="$OUT_DIR/triage-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(mail +triage --format json --max "\${MAIL_MAX:-20}")
if [ -n "$QUERY" ]; then ARGS+=(--query "$QUERY"); fi
if [ -n "\${MAIL_FILTER:-}" ]; then ARGS+=(--filter "$MAIL_FILTER"); fi
if [ -n "\${MAILBOX:-}" ]; then ARGS+=(--mailbox "$MAILBOX"); fi
if [ "\${MAIL_LABELS:-0}" = "1" ]; then ARGS+=(--labels); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-mail"
  yaml_kv title "Feishu Mail Triage $STAMP"
  yaml_kv query "$QUERY"
  yaml_kv mailbox "\${MAILBOX:-me}"
  yaml_kv max "\${MAIL_MAX:-20}"
  yaml_bool_kv labels "\${MAIL_LABELS:-0}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli mail +triage --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Mail Triage $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check mail access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update mail triage $STAMP"
echo "Wrote $OUT"
`;
}

export function buildBaseTablesScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
BASE_TOKEN="\${1:-}"

if [ -z "$BASE_TOKEN" ]; then
  echo "Usage: $0 <base-token>" >&2
  exit 2
fi

STAMP="$(date +%Y-%m-%d-%H%M%S)"
TOKEN_HASH="$(printf '%s' "$BASE_TOKEN" | shasum -a 256 | cut -c1-12)"
OUT_DIR="$ROOT/feishu/base"
OUT="$OUT_DIR/tables-$TOKEN_HASH-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(base +table-list --base-token "$BASE_TOKEN" --limit "\${BASE_LIMIT:-50}" --offset "\${BASE_OFFSET:-0}")

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-base"
  yaml_kv title "Feishu Base Tables $STAMP"
  echo "base_scope: tables"
  yaml_kv base_token_hash "$TOKEN_HASH"
  yaml_kv limit "\${BASE_LIMIT:-50}"
  yaml_kv offset "\${BASE_OFFSET:-0}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli base +table-list --base-token <redacted>"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Base Tables $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Base access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update base tables $STAMP"
echo "Wrote $OUT"
`;
}

export function buildBaseFieldsScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
BASE_TOKEN="\${1:-}"
TABLE_ID="\${2:-}"

if [ -z "$BASE_TOKEN" ] || [ -z "$TABLE_ID" ]; then
  echo "Usage: $0 <base-token> <table-id-or-name>" >&2
  exit 2
fi

STAMP="$(date +%Y-%m-%d-%H%M%S)"
TOKEN_HASH="$(printf '%s' "$BASE_TOKEN" | shasum -a 256 | cut -c1-12)"
SAFE_TABLE="$(printf '%s' "$TABLE_ID" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-96)"
OUT_DIR="$ROOT/feishu/base"
OUT="$OUT_DIR/fields-$SAFE_TABLE-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(base +field-list --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --limit "\${BASE_LIMIT:-100}" --offset "\${BASE_OFFSET:-0}")

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-base"
  yaml_kv title "Feishu Base Fields $TABLE_ID $STAMP"
  echo "base_scope: fields"
  yaml_kv base_token_hash "$TOKEN_HASH"
  yaml_kv table_id "$TABLE_ID"
  yaml_kv limit "\${BASE_LIMIT:-100}"
  yaml_kv offset "\${BASE_OFFSET:-0}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli base +field-list --base-token <redacted>"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Base Fields $TABLE_ID $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Base access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update base fields $TABLE_ID $STAMP"
echo "Wrote $OUT"
`;
}

export function buildBaseRecordsScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
BASE_TOKEN="\${1:-}"
TABLE_ID="\${2:-}"

if [ -z "$BASE_TOKEN" ] || [ -z "$TABLE_ID" ]; then
  echo "Usage: $0 <base-token> <table-id-or-name>" >&2
  exit 2
fi

STAMP="$(date +%Y-%m-%d-%H%M%S)"
TOKEN_HASH="$(printf '%s' "$BASE_TOKEN" | shasum -a 256 | cut -c1-12)"
SAFE_TABLE="$(printf '%s' "$TABLE_ID" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-96)"
OUT_DIR="$ROOT/feishu/base"
OUT="$OUT_DIR/records-$SAFE_TABLE-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(base +record-list --format json --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --limit "\${BASE_LIMIT:-100}" --offset "\${BASE_OFFSET:-0}")
if [ -n "\${BASE_VIEW_ID:-}" ]; then ARGS+=(--view-id "$BASE_VIEW_ID"); fi
if [ -n "\${BASE_FIELD_IDS:-}" ]; then
  IFS=',' read -r -a FIELD_LIST <<< "$BASE_FIELD_IDS"
  for field in "\${FIELD_LIST[@]}"; do
    if [ -n "$field" ]; then ARGS+=(--field-id "$field"); fi
  done
fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-base"
  yaml_kv title "Feishu Base Records $TABLE_ID $STAMP"
  echo "base_scope: records"
  yaml_kv base_token_hash "$TOKEN_HASH"
  yaml_kv table_id "$TABLE_ID"
  yaml_kv view_id "\${BASE_VIEW_ID:-}"
  yaml_kv field_ids "\${BASE_FIELD_IDS:-}"
  yaml_kv limit "\${BASE_LIMIT:-100}"
  yaml_kv offset "\${BASE_OFFSET:-0}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli base +record-list --format json --base-token <redacted>"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Base Records $TABLE_ID $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Base access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update base records $TABLE_ID $STAMP"
echo "Wrote $OUT"
`;
}

export function buildBaseSearchScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
BASE_TOKEN="\${1:-}"
TABLE_ID="\${2:-}"
SEARCH_JSON="\${3:-}"

if [ -z "$BASE_TOKEN" ] || [ -z "$TABLE_ID" ] || [ -z "$SEARCH_JSON" ]; then
  echo "Usage: $0 <base-token> <table-id-or-name> <search-json>" >&2
  exit 2
fi

STAMP="$(date +%Y-%m-%d-%H%M%S)"
TOKEN_HASH="$(printf '%s' "$BASE_TOKEN" | shasum -a 256 | cut -c1-12)"
SAFE_TABLE="$(printf '%s' "$TABLE_ID" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-96)"
OUT_DIR="$ROOT/feishu/base"
OUT="$OUT_DIR/search-$SAFE_TABLE-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(base +record-search --format json --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --json "$SEARCH_JSON")

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-base"
  yaml_kv title "Feishu Base Search $TABLE_ID $STAMP"
  echo "base_scope: search"
  yaml_kv base_token_hash "$TOKEN_HASH"
  yaml_kv table_id "$TABLE_ID"
  yaml_kv search_json "$SEARCH_JSON"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli base +record-search --format json --base-token <redacted>"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Base Search $TABLE_ID $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Base access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update base search $TABLE_ID $STAMP"
echo "Wrote $OUT"
`;
}

export function buildImChatListScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/im"
OUT="$OUT_DIR/chat-list-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(im +chat-list --format json --page-size "\${IM_PAGE_SIZE:-20}")
if [ -n "\${IM_TYPES:-}" ]; then ARGS+=(--types "$IM_TYPES"); fi
if [ -n "\${IM_SORT_TYPE:-}" ]; then ARGS+=(--sort-type "$IM_SORT_TYPE"); fi
if [ "\${IM_EXCLUDE_MUTED:-0}" = "1" ]; then ARGS+=(--exclude-muted); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-im"
  yaml_kv title "Feishu IM Chat List $STAMP"
  echo "im_scope: chat-list"
  yaml_kv types "\${IM_TYPES:-group}"
  yaml_kv page_size "\${IM_PAGE_SIZE:-20}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli im +chat-list --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu IM Chat List $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check IM access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update im chat list $STAMP"
echo "Wrote $OUT"
`;
}

export function buildImChatSearchScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
QUERY="\${1:-}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/im"
OUT="$OUT_DIR/chat-search-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(im +chat-search --format json --page-size "\${IM_PAGE_SIZE:-20}")
if [ -n "$QUERY" ]; then ARGS+=(--query "$QUERY"); fi
if [ -n "\${IM_MEMBER_IDS:-}" ]; then ARGS+=(--member-ids "$IM_MEMBER_IDS"); fi
if [ -n "\${IM_SEARCH_TYPES:-}" ]; then ARGS+=(--search-types "$IM_SEARCH_TYPES"); fi
if [ -n "\${IM_SORT_BY:-}" ]; then ARGS+=(--sort-by "$IM_SORT_BY"); fi
if [ "\${IM_EXCLUDE_MUTED:-0}" = "1" ]; then ARGS+=(--exclude-muted); fi
if [ "\${IM_IS_MANAGER:-0}" = "1" ]; then ARGS+=(--is-manager); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-im"
  yaml_kv title "Feishu IM Chat Search $STAMP"
  echo "im_scope: chat-search"
  yaml_kv query "$QUERY"
  yaml_kv page_size "\${IM_PAGE_SIZE:-20}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli im +chat-search --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu IM Chat Search $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check IM access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update im chat search $STAMP"
echo "Wrote $OUT"
`;
}

export function buildImChatMessagesScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
CHAT_ID="\${1:-}"

if [ -z "$CHAT_ID" ]; then
  echo "Usage: $0 <chat-id>" >&2
  exit 2
fi

STAMP="$(date +%Y-%m-%d-%H%M%S)"
SAFE_CHAT="$(printf '%s' "$CHAT_ID" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-96)"
OUT_DIR="$ROOT/feishu/im"
OUT="$OUT_DIR/chat-messages-$SAFE_CHAT-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(im +chat-messages-list --format json --chat-id "$CHAT_ID" --page-size "\${IM_PAGE_SIZE:-50}")
if [ -n "\${IM_START:-}" ]; then ARGS+=(--start "$IM_START"); fi
if [ -n "\${IM_END:-}" ]; then ARGS+=(--end "$IM_END"); fi
if [ -n "\${IM_SORT:-}" ]; then ARGS+=(--sort "$IM_SORT"); fi
if [ "\${IM_NO_REACTIONS:-0}" = "1" ]; then ARGS+=(--no-reactions); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-im"
  yaml_kv title "Feishu IM Chat Messages $STAMP"
  echo "im_scope: chat-messages"
  yaml_kv chat_id "$CHAT_ID"
  yaml_kv start "\${IM_START:-}"
  yaml_kv end "\${IM_END:-}"
  yaml_kv page_size "\${IM_PAGE_SIZE:-50}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli im +chat-messages-list --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu IM Chat Messages $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check IM access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update im chat messages $STAMP"
echo "Wrote $OUT"
`;
}

export function buildImMessageSearchScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
QUERY="\${1:-}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/im"
OUT="$OUT_DIR/message-search-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(im +messages-search --format json --page-size "\${IM_PAGE_SIZE:-20}")
if [ -n "$QUERY" ]; then ARGS+=(--query "$QUERY"); fi
if [ -n "\${IM_CHAT_ID:-}" ]; then ARGS+=(--chat-id "$IM_CHAT_ID"); fi
if [ -n "\${IM_START:-}" ]; then ARGS+=(--start "$IM_START"); fi
if [ -n "\${IM_END:-}" ]; then ARGS+=(--end "$IM_END"); fi
if [ "\${IM_PAGE_ALL:-0}" = "1" ]; then ARGS+=(--page-all --page-limit "\${IM_PAGE_LIMIT:-20}"); fi
if [ "\${IM_IS_AT_ME:-0}" = "1" ]; then ARGS+=(--is-at-me); fi
if [ "\${IM_NO_REACTIONS:-0}" = "1" ]; then ARGS+=(--no-reactions); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-im"
  yaml_kv title "Feishu IM Message Search $STAMP"
  echo "im_scope: message-search"
  yaml_kv query "$QUERY"
  yaml_kv chat_id "\${IM_CHAT_ID:-}"
  yaml_kv start "\${IM_START:-}"
  yaml_kv end "\${IM_END:-}"
  yaml_kv page_size "\${IM_PAGE_SIZE:-20}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli im +messages-search --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu IM Message Search $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check IM access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update im message search $STAMP"
echo "Wrote $OUT"
`;
}

export function buildImFlagsScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/im"
OUT="$OUT_DIR/flags-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(im +flag-list --format json --page-size "\${IM_PAGE_SIZE:-50}")
if [ "\${IM_PAGE_ALL:-0}" = "1" ]; then ARGS+=(--page-all --page-limit "\${IM_PAGE_LIMIT:-20}"); fi
if [ "\${IM_NO_ENRICH_FEED_THREAD:-0}" = "1" ]; then ARGS+=(--enrich-feed-thread=false); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-im"
  yaml_kv title "Feishu IM Flags $STAMP"
  echo "im_scope: flags"
  yaml_kv page_size "\${IM_PAGE_SIZE:-50}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli im +flag-list --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu IM Flags $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check IM access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update im flags $STAMP"
echo "Wrote $OUT"
`;
}

export function buildApprovalTasksScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/approvals"
OUT="$OUT_DIR/tasks-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(approval tasks query --format json)
if [ "\${APPROVAL_PAGE_ALL:-1}" != "0" ]; then
  ARGS+=(--page-all --page-limit "\${APPROVAL_PAGE_LIMIT:-10}")
fi
if [ -n "\${APPROVAL_PARAMS:-}" ]; then ARGS+=(--params "$APPROVAL_PARAMS"); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-approval"
  yaml_kv title "Feishu Approval Tasks $STAMP"
  echo "approval_scope: tasks"
  yaml_kv params "\${APPROVAL_PARAMS:-}"
  yaml_bool_kv page_all "\${APPROVAL_PAGE_ALL:-1}"
  yaml_kv page_limit "\${APPROVAL_PAGE_LIMIT:-10}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli approval tasks query --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Approval Tasks $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Approval access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update approval tasks $STAMP"
echo "Wrote $OUT"
`;
}

export function buildApprovalInitiatedScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/approvals"
OUT="$OUT_DIR/initiated-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(approval instances initiated --format json)
if [ "\${APPROVAL_PAGE_ALL:-1}" != "0" ]; then
  ARGS+=(--page-all --page-limit "\${APPROVAL_PAGE_LIMIT:-10}")
fi
if [ -n "\${APPROVAL_PARAMS:-}" ]; then ARGS+=(--params "$APPROVAL_PARAMS"); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-approval"
  yaml_kv title "Feishu Approval Initiated $STAMP"
  echo "approval_scope: initiated"
  yaml_kv params "\${APPROVAL_PARAMS:-}"
  yaml_bool_kv page_all "\${APPROVAL_PAGE_ALL:-1}"
  yaml_kv page_limit "\${APPROVAL_PAGE_LIMIT:-10}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli approval instances initiated --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Approval Initiated $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check Approval access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update approval initiated $STAMP"
echo "Wrote $OUT"
`;
}

export function buildOkrCyclesScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
TIME_RANGE="\${1:-}"
if [ -z "$TIME_RANGE" ]; then TIME_RANGE="\${OKR_TIME_RANGE:-}"; fi
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT/feishu/okr"
OUT="$OUT_DIR/cycles-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(okr +cycle-list --format json)
if [ -n "$TIME_RANGE" ]; then ARGS+=(--time-range "$TIME_RANGE"); fi
if [ -n "\${OKR_USER_ID:-}" ]; then ARGS+=(--user-id "$OKR_USER_ID"); fi
if [ -n "\${OKR_USER_ID_TYPE:-}" ]; then ARGS+=(--user-id-type "$OKR_USER_ID_TYPE"); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-okr"
  yaml_kv title "Feishu OKR Cycles $STAMP"
  echo "okr_scope: cycles"
  yaml_kv time_range "$TIME_RANGE"
  yaml_kv user_id "\${OKR_USER_ID:-}"
  yaml_kv user_id_type "\${OKR_USER_ID_TYPE:-open_id}"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli okr +cycle-list --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu OKR Cycles $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check OKR access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update okr cycles $STAMP"
echo "Wrote $OUT"
`;
}

export function buildOkrCycleDetailScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
CYCLE_ID="\${1:-}"

if [ -z "$CYCLE_ID" ]; then
  echo "Usage: $0 <cycle-id>" >&2
  exit 2
fi

STAMP="$(date +%Y-%m-%d-%H%M%S)"
SAFE_CYCLE="$(printf '%s' "$CYCLE_ID" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-96)"
OUT_DIR="$ROOT/feishu/okr"
OUT="$OUT_DIR/cycle-$SAFE_CYCLE-$STAMP.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli okr +cycle-detail --format json --cycle-id "$CYCLE_ID" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-okr"
  yaml_kv title "Feishu OKR Cycle $CYCLE_ID $STAMP"
  echo "okr_scope: cycle-detail"
  yaml_kv cycle_id "$CYCLE_ID"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli okr +cycle-detail --format json"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu OKR Cycle $CYCLE_ID $STAMP"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check OKR access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update okr cycle $CYCLE_ID $STAMP"
echo "Wrote $OUT"
`;
}

export function buildTasksScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
QUERY="\${1:-}"
DAY="$(date +%F)"
OUT_DIR="$ROOT/feishu/tasks"
OUT="$OUT_DIR/my-tasks-$DAY.md"

mkdir -p "$OUT_DIR"

${buildAutoCommitShellFunction()}

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found. Install and authenticate lark-cli first." >&2
  exit 127
fi

ARGS=(task +get-my-tasks --format json --page-all)
if [ -n "$QUERY" ]; then ARGS+=(--query "$QUERY"); fi

TMP="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT

STATUS=0
lark-cli "\${ARGS[@]}" >"$TMP" 2>"$ERR" || STATUS=$?

  {
  echo "---"
  echo "type: feishu-task"
  yaml_kv title "Feishu Tasks $DAY"
  yaml_kv query "$QUERY"
  echo "captured_via: lark-cli"
  echo "source_command: lark-cli task +get-my-tasks --format json --page-all"
  yaml_kv captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
  echo
  echo "# Feishu Tasks $DAY"
  echo
  if [ "$STATUS" -eq 0 ]; then
    echo '\`\`\`json'
    cat "$TMP"
    echo
    echo '\`\`\`'
  else
    echo "> Collection failed. Check task access and run \`lark-cli doctor\`."
    echo
    echo "Exit status: $STATUS"
    echo
    echo '\`\`\`text'
    cat "$ERR"
    echo
    echo '\`\`\`'
    exit "$STATUS"
  fi
} > "$OUT"

commit_snapshot "$OUT" "feishu: update tasks $DAY"
echo "Wrote $OUT"
`;
}

export function buildRefreshScript(root: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=${JSON.stringify(root)}
RBRAIN_BIN="\${RBRAIN_BIN:-${brand()}}"
SOURCE_ID="\${RBRAIN_SOURCE_ID:-feishu}"

if ! command -v "$RBRAIN_BIN" >/dev/null 2>&1; then
  echo "$RBRAIN_BIN not found. Set RBRAIN_BIN to your rbrain executable." >&2
  exit 127
fi

exec "$RBRAIN_BIN" feishu refresh --path "$ROOT" --source-id "$SOURCE_ID" "$@"
`;
}

function writeIfNeeded(path: string, content: string, force: boolean, mode?: number): 'created' | 'updated' | 'skipped' {
  const existedBefore = existsSync(path);
  if (existedBefore && !force) return 'skipped';
  writeFileSync(path, content, 'utf-8');
  if (mode !== undefined) {
    try { chmodSync(path, mode); } catch { /* best-effort on non-POSIX filesystems */ }
  }
  return existedBefore ? 'updated' : 'created';
}

function createMirror(opts: InitOpts): MirrorInitResult {
  mkdirSync(opts.path, { recursive: true });

  const dirs: string[] = [];
  for (const rel of FEISHU_MIRROR_DIRS) {
    const dir = join(opts.path, rel);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
  }

  const readmePath = join(opts.path, 'README.md');
  const gitignorePath = join(opts.path, '.gitignore');
  const ailyEnvExamplePath = join(opts.path, '.env.aily.example');
  const agendaScriptPath = join(opts.path, 'scripts', 'pull-feishu-agenda.sh');
  const docScriptPath = join(opts.path, 'scripts', 'pull-feishu-doc.sh');
  const docListScriptPath = join(opts.path, 'scripts', 'pull-feishu-docs-list.sh');
  const docListManifestPath = join(opts.path, 'feishu', 'docs', 'docs-list.tsv');
  const driveSearchScriptPath = join(opts.path, 'scripts', 'pull-feishu-drive-search.sh');
  const wikiSpacesScriptPath = join(opts.path, 'scripts', 'pull-feishu-wiki-spaces.sh');
  const wikiNodesScriptPath = join(opts.path, 'scripts', 'pull-feishu-wiki-nodes.sh');
  const minutesScriptPath = join(opts.path, 'scripts', 'pull-feishu-minutes-search.sh');
  const mailTriageScriptPath = join(opts.path, 'scripts', 'pull-feishu-mail-triage.sh');
  const approvalTasksScriptPath = join(opts.path, 'scripts', 'pull-feishu-approval-tasks.sh');
  const approvalInitiatedScriptPath = join(opts.path, 'scripts', 'pull-feishu-approval-initiated.sh');
  const okrCyclesScriptPath = join(opts.path, 'scripts', 'pull-feishu-okr-cycles.sh');
  const okrCycleDetailScriptPath = join(opts.path, 'scripts', 'pull-feishu-okr-cycle-detail.sh');
  const baseTablesScriptPath = join(opts.path, 'scripts', 'pull-feishu-base-tables.sh');
  const baseFieldsScriptPath = join(opts.path, 'scripts', 'pull-feishu-base-fields.sh');
  const baseRecordsScriptPath = join(opts.path, 'scripts', 'pull-feishu-base-records.sh');
  const baseSearchScriptPath = join(opts.path, 'scripts', 'pull-feishu-base-search.sh');
  const imChatListScriptPath = join(opts.path, 'scripts', 'pull-feishu-im-chat-list.sh');
  const imChatSearchScriptPath = join(opts.path, 'scripts', 'pull-feishu-im-chat-search.sh');
  const imChatMessagesScriptPath = join(opts.path, 'scripts', 'pull-feishu-im-chat-messages.sh');
  const imMessageSearchScriptPath = join(opts.path, 'scripts', 'pull-feishu-im-message-search.sh');
  const imFlagsScriptPath = join(opts.path, 'scripts', 'pull-feishu-im-flags.sh');
  const tasksScriptPath = join(opts.path, 'scripts', 'pull-feishu-tasks.sh');
  const refreshScriptPath = join(opts.path, 'scripts', 'refresh-feishu.sh');
  const readmeStatus = writeIfNeeded(readmePath, buildMirrorReadme(opts.path), opts.force);
  const gitignoreStatus = writeIfNeeded(gitignorePath, buildMirrorGitignore(), opts.force);
  const ailyEnvExampleStatus = writeIfNeeded(ailyEnvExamplePath, buildAilyEnvExample(), opts.force);
  const agendaStatus = writeIfNeeded(agendaScriptPath, buildAgendaScript(opts.path), opts.force, 0o755);
  const docStatus = writeIfNeeded(docScriptPath, buildDocScript(opts.path), opts.force, 0o755);
  const docListStatus = writeIfNeeded(docListScriptPath, buildDocListScript(opts.path), opts.force, 0o755);
  const docListManifestStatus = writeIfNeeded(docListManifestPath, buildDocListManifestTemplate(), opts.force);
  const driveSearchStatus = writeIfNeeded(driveSearchScriptPath, buildDriveSearchScript(opts.path), opts.force, 0o755);
  const wikiSpacesStatus = writeIfNeeded(wikiSpacesScriptPath, buildWikiSpacesScript(opts.path), opts.force, 0o755);
  const wikiNodesStatus = writeIfNeeded(wikiNodesScriptPath, buildWikiNodesScript(opts.path), opts.force, 0o755);
  const minutesStatus = writeIfNeeded(minutesScriptPath, buildMinutesSearchScript(opts.path), opts.force, 0o755);
  const mailTriageStatus = writeIfNeeded(mailTriageScriptPath, buildMailTriageScript(opts.path), opts.force, 0o755);
  const approvalTasksStatus = writeIfNeeded(approvalTasksScriptPath, buildApprovalTasksScript(opts.path), opts.force, 0o755);
  const approvalInitiatedStatus = writeIfNeeded(approvalInitiatedScriptPath, buildApprovalInitiatedScript(opts.path), opts.force, 0o755);
  const okrCyclesStatus = writeIfNeeded(okrCyclesScriptPath, buildOkrCyclesScript(opts.path), opts.force, 0o755);
  const okrCycleDetailStatus = writeIfNeeded(okrCycleDetailScriptPath, buildOkrCycleDetailScript(opts.path), opts.force, 0o755);
  const baseTablesStatus = writeIfNeeded(baseTablesScriptPath, buildBaseTablesScript(opts.path), opts.force, 0o755);
  const baseFieldsStatus = writeIfNeeded(baseFieldsScriptPath, buildBaseFieldsScript(opts.path), opts.force, 0o755);
  const baseRecordsStatus = writeIfNeeded(baseRecordsScriptPath, buildBaseRecordsScript(opts.path), opts.force, 0o755);
  const baseSearchStatus = writeIfNeeded(baseSearchScriptPath, buildBaseSearchScript(opts.path), opts.force, 0o755);
  const imChatListStatus = writeIfNeeded(imChatListScriptPath, buildImChatListScript(opts.path), opts.force, 0o755);
  const imChatSearchStatus = writeIfNeeded(imChatSearchScriptPath, buildImChatSearchScript(opts.path), opts.force, 0o755);
  const imChatMessagesStatus = writeIfNeeded(imChatMessagesScriptPath, buildImChatMessagesScript(opts.path), opts.force, 0o755);
  const imMessageSearchStatus = writeIfNeeded(imMessageSearchScriptPath, buildImMessageSearchScript(opts.path), opts.force, 0o755);
  const imFlagsStatus = writeIfNeeded(imFlagsScriptPath, buildImFlagsScript(opts.path), opts.force, 0o755);
  const tasksStatus = writeIfNeeded(tasksScriptPath, buildTasksScript(opts.path), opts.force, 0o755);
  const refreshStatus = writeIfNeeded(refreshScriptPath, buildRefreshScript(opts.path), opts.force, 0o755);
  const gitStatus = ensureGitRepository(opts.path, opts.git);

  return {
    status: 'ok',
    path: opts.path,
    dirs,
    files: [
      { path: readmePath, status: readmeStatus },
      { path: gitignorePath, status: gitignoreStatus },
      { path: ailyEnvExamplePath, status: ailyEnvExampleStatus },
      { path: agendaScriptPath, status: agendaStatus },
      { path: docScriptPath, status: docStatus },
      { path: docListScriptPath, status: docListStatus },
      { path: docListManifestPath, status: docListManifestStatus },
      { path: driveSearchScriptPath, status: driveSearchStatus },
      { path: wikiSpacesScriptPath, status: wikiSpacesStatus },
      { path: wikiNodesScriptPath, status: wikiNodesStatus },
      { path: minutesScriptPath, status: minutesStatus },
      { path: mailTriageScriptPath, status: mailTriageStatus },
      { path: approvalTasksScriptPath, status: approvalTasksStatus },
      { path: approvalInitiatedScriptPath, status: approvalInitiatedStatus },
      { path: okrCyclesScriptPath, status: okrCyclesStatus },
      { path: okrCycleDetailScriptPath, status: okrCycleDetailStatus },
      { path: baseTablesScriptPath, status: baseTablesStatus },
      { path: baseFieldsScriptPath, status: baseFieldsStatus },
      { path: baseRecordsScriptPath, status: baseRecordsStatus },
      { path: baseSearchScriptPath, status: baseSearchStatus },
      { path: imChatListScriptPath, status: imChatListStatus },
      { path: imChatSearchScriptPath, status: imChatSearchStatus },
      { path: imChatMessagesScriptPath, status: imChatMessagesStatus },
      { path: imMessageSearchScriptPath, status: imMessageSearchStatus },
      { path: imFlagsScriptPath, status: imFlagsStatus },
      { path: tasksScriptPath, status: tasksStatus },
      { path: refreshScriptPath, status: refreshStatus },
    ],
    git: gitStatus,
    next: [
      `${brand()} feishu setup --path "${opts.path}"`,
      `${brand()} sync --source feishu`,
    ],
  };
}

function printInitResult(payload: MirrorInitResult): void {
  console.log(`Feishu mirror ready: ${payload.path}`);
  for (const file of payload.files) {
    const rel = file.path.startsWith(payload.path + '/') ? file.path.slice(payload.path.length + 1) : file.path;
    console.log(`  ${rel}: ${file.status}`);
  }
  const gitLine = payload.git.error
    ? `${payload.git.repository}, commit ${payload.git.commit} (${payload.git.error})`
    : `${payload.git.repository}, commit ${payload.git.commit}`;
  console.log(`  git: ${gitLine}`);
  console.log('');
  console.log('Next:');
  for (const cmd of payload.next) console.log(`  ${cmd}`);
}

async function runInit(args: string[]): Promise<void> {
  const opts = parseInit(args);
  const payload = createMirror(opts);

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printInitResult(payload);
}

async function registerFeishuSource(engine: BrainEngine, opts: SetupOpts): Promise<SourceSetupResult> {
  assertValidSourceId(opts.sourceId);

  const existing = await engine.executeRaw<{
    id: string;
    name: string;
    local_path: string | null;
    config: unknown;
  }>(
    `SELECT id, name, local_path, config FROM sources WHERE id = $1`,
    [opts.sourceId],
  );

  const configPatch = {
    federated: true,
    kind: 'feishu-mirror',
    schema_pack: 'rbrain-feishu',
  };

  if (existing.length === 0) {
    try {
      await addBrainSource(engine, {
        id: opts.sourceId,
        name: opts.name,
        localPath: opts.path,
        federated: true,
      });
      await engine.executeRaw(
        `UPDATE sources SET config = (COALESCE(config, '{}'::jsonb) || $1::jsonb) WHERE id = $2`,
        [JSON.stringify(configPatch), opts.sourceId],
      );
      await ensureFeishuSourceSchemaPack(engine, opts.sourceId);
    } catch (e) {
      if (!(e instanceof SourceOpError) || e.code !== 'source_id_taken') throw e;
      return registerFeishuSource(engine, opts);
    }
    if (opts.setDefault) await engine.setConfig('sources.default', opts.sourceId);
    return {
      source_id: opts.sourceId,
      status: 'created',
      path: opts.path,
      name: opts.name,
      federated: true,
      default: opts.setDefault,
    };
  }

  const row = existing[0]!;
  const existingPath = row.local_path ? resolve(row.local_path) : null;
  if (existingPath && existingPath !== opts.path && !opts.force) {
    throw new Error(
      `Source "${opts.sourceId}" already points at ${row.local_path}. ` +
      `Pass --force to repoint it to ${opts.path}.`,
    );
  }

  const nextConfig = {
    ...parseJsonObject(row.config),
    ...configPatch,
  };
  const pathChanged = existingPath !== opts.path;
  const nameChanged = row.name !== opts.name;
  const configChanged = JSON.stringify(parseJsonObject(row.config)) !== JSON.stringify(nextConfig);

  if (pathChanged || nameChanged || configChanged) {
    await engine.executeRaw(
      `UPDATE sources SET name = $1, local_path = $2, config = $3::jsonb WHERE id = $4`,
      [opts.name, opts.path, JSON.stringify(nextConfig), opts.sourceId],
    );
  }
  const sourcePackChanged = await ensureFeishuSourceSchemaPack(engine, opts.sourceId);
  if (opts.setDefault) await engine.setConfig('sources.default', opts.sourceId);

  return {
    source_id: opts.sourceId,
    status: pathChanged || nameChanged || configChanged || sourcePackChanged ? 'updated' : 'already_registered',
    path: opts.path,
    name: opts.name,
    federated: true,
    default: opts.setDefault,
  };
}

async function ensureFeishuSourceSchemaPack(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const key = `schema_pack.source.${sourceId}`;
  const current = await engine.getConfig(key);
  if (current === 'rbrain-feishu') return false;
  await engine.setConfig(key, 'rbrain-feishu');
  return true;
}

async function syncFeishuSource(
  engine: BrainEngine,
  opts: { sourceId: string; path: string; noEmbed: boolean; full?: boolean },
): Promise<unknown> {
  const { performSync } = await import('./sync.ts');
  return performSync(engine, {
    sourceId: opts.sourceId,
    repoPath: opts.path,
    full: opts.full ?? false,
    noPull: true,
    noEmbed: opts.noEmbed,
  });
}

async function withCapturedStdout<T>(fn: () => Promise<T>): Promise<CapturedResult<T>> {
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalInfo = console.info;
  let captured = '';
  const appendConsole = (...args: unknown[]) => {
    captured += args.map((arg) => {
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' ') + '\n';
  };
  const replacement = ((chunk: unknown, ...args: unknown[]) => {
    if (typeof chunk === 'string') captured += chunk;
    else if (chunk instanceof Uint8Array) captured += Buffer.from(chunk).toString('utf-8');
    const cb = args.find((arg): arg is (err?: Error | null) => void => typeof arg === 'function');
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = replacement;
  console.log = appendConsole;
  console.info = appendConsole;
  try {
    return { result: await fn(), stdout: captured };
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    process.stdout.write = originalWrite;
  }
}

async function resolveMirrorRoot(engine: BrainEngine, opts: { sourceId: string; path?: string }): Promise<string> {
  if (opts.path) return opts.path;
  assertValidSourceId(opts.sourceId);
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [opts.sourceId],
  );
  const path = rows[0]?.local_path;
  if (!path) {
    throw new Error(
      `Source "${opts.sourceId}" is not registered with a local path. ` +
      `Run ${brand()} feishu setup --path ~/rbrain-feishu first.`,
    );
  }
  return resolve(path);
}

async function resolvePullRoot(engine: BrainEngine, opts: PullOpts): Promise<string> {
  return resolveMirrorRoot(engine, opts);
}

function runLark(argv: string[]): string {
  const result = runLocalCommand(argv, { timeout: 60_000 });
  if (!result.ok) {
    throw new Error(
      `Feishu collection failed: ${argv.join(' ')}\n` +
      (result.stderr || result.stdout || `exit ${result.status}`),
    );
  }
  return result.stdout;
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function minuteStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

async function runPull(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parsePull(args);
  const root = await resolvePullRoot(engine, opts);
  if (opts.kind === 'docs-list') {
    const snapshots = collectDocList(root, opts);
    const syncRun = opts.sync
      ? opts.json
        ? await withCapturedStdout(() => syncFeishuSource(engine, {
            sourceId: opts.sourceId,
            path: root,
            noEmbed: opts.noEmbed,
          }))
        : { result: await syncFeishuSource(engine, {
            sourceId: opts.sourceId,
            path: root,
            noEmbed: opts.noEmbed,
          }), stdout: '' }
      : null;
    const payload = {
      status: 'ok',
      kind: opts.kind,
      path: root,
      file: opts.file ? expandPath(opts.file) : null,
      count: snapshots.length,
      snapshots,
      sync: syncRun ? syncRun.result : null,
    };
    const payloadWithLogs = syncRun?.stdout ? { ...payload, sync_stdout: syncRun.stdout } : payload;
    if (opts.json) {
      console.log(JSON.stringify(payloadWithLogs, null, 2));
      return;
    }
    console.log(`Feishu docs-list snapshots written: ${snapshots.length}`);
    for (const snapshot of snapshots) console.log(`  ${snapshot.output} (${snapshot.commit})`);
    if (opts.sync) console.log(`  synced source: ${opts.sourceId}`);
    else console.log(`  next: ${brand()} sync --source ${opts.sourceId} --no-embed`);
    return;
  }

  const snapshot = collectSnapshot(root, opts);
  const syncRun = opts.sync
    ? opts.json
      ? await withCapturedStdout(() => syncFeishuSource(engine, {
          sourceId: opts.sourceId,
          path: root,
          noEmbed: opts.noEmbed,
        }))
      : { result: await syncFeishuSource(engine, {
          sourceId: opts.sourceId,
          path: root,
          noEmbed: opts.noEmbed,
        }), stdout: '' }
    : null;

  const payload: PullResult = {
    ...snapshot,
    sync: syncRun ? syncRun.result : null,
  };
  const payloadWithLogs = syncRun?.stdout ? { ...payload, sync_stdout: syncRun.stdout } : payload;

  if (opts.json) {
    console.log(JSON.stringify(payloadWithLogs, null, 2));
    return;
  }

  console.log(`Feishu ${opts.kind} snapshot written: ${snapshot.output}`);
  console.log(`  commit: ${snapshot.commit}`);
  if (opts.sync) console.log(`  synced source: ${opts.sourceId}`);
  else console.log(`  next: ${brand()} sync --source ${opts.sourceId} --no-embed`);
}

function collectDocList(root: string, opts: PullOpts): SnapshotResult[] {
  if (!opts.file) {
    throw new Error(`Usage: ${brand()} feishu pull docs-list --file <manifest.tsv> [--sync]`);
  }
  const manifestPath = expandPath(opts.file);
  const entries = parseDocManifest(readFileSync(manifestPath, 'utf-8'));
  if (entries.length === 0) {
    throw new Error(`No Feishu documents found in manifest: ${manifestPath}`);
  }
  return entries.map((entry) => collectSnapshot(root, {
    ...opts,
    kind: 'doc',
    doc: entry.doc,
    slug: entry.slug,
  }));
}

function collectSnapshot(root: string, opts: PullOpts): SnapshotResult {
  let output: string;
  let command: string[];
  let body: string;
  let commitMessage: string;

  if (opts.kind === 'agenda') {
    const day = dateStamp();
    command = ['lark-cli', 'calendar', '+agenda', '--format', 'json'];
    output = join(root, 'feishu', 'calendar', `${day}.md`);
    body = buildAgendaMarkdown(day, runLark(command));
    commitMessage = `feishu: update agenda ${day}`;
  } else if (opts.kind === 'tasks') {
    const day = dateStamp();
    command = ['lark-cli', 'task', '+get-my-tasks', '--format', 'json', '--page-all'];
    if (opts.query) command.push('--query', opts.query);
    if (opts.complete !== undefined) command.push(`--complete=${String(opts.complete)}`);
    if (opts.createdAt) command.push('--created_at', opts.createdAt);
    if (opts.dueStart) command.push('--due-start', opts.dueStart);
    if (opts.dueEnd) command.push('--due-end', opts.dueEnd);
    output = join(root, 'feishu', 'tasks', `my-tasks-${day}.md`);
    body = buildTasksMarkdown(day, opts, runLark(command));
    commitMessage = `feishu: update tasks ${day}`;
  } else if (opts.kind === 'doc') {
    if (!opts.doc) throw new Error(`Usage: ${brand()} feishu pull doc <feishu-doc-url-or-token> [slug]`);
    const slug = normalizeDocSlug(opts.slug || slugForDoc(opts.doc));
    command = ['lark-cli', 'docs', '+fetch', '--api-version', 'v2', '--doc', opts.doc, '--doc-format', 'markdown', '--format', 'json'];
    output = join(root, 'feishu', 'docs', `${slug}.md`);
    body = buildDocMarkdown(slug, opts.doc, runLark(command));
    commitMessage = `feishu: update doc ${slug}`;
  } else if (opts.kind === 'drive-search') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'drive', '+search', '--format', 'json'];
    if (opts.query) command.push('--query', opts.query);
    if (opts.docTypes) command.push('--doc-types', opts.docTypes);
    if (opts.spaceIds) command.push('--space-ids', opts.spaceIds);
    if (opts.folderTokens) command.push('--folder-tokens', opts.folderTokens);
    if (opts.sort) command.push('--sort', opts.sort);
    if (opts.editedSince) command.push('--edited-since', opts.editedSince);
    if (opts.editedUntil) command.push('--edited-until', opts.editedUntil);
    if (opts.openedSince) command.push('--opened-since', opts.openedSince);
    if (opts.openedUntil) command.push('--opened-until', opts.openedUntil);
    if (opts.createdSince) command.push('--created-since', opts.createdSince);
    if (opts.createdUntil) command.push('--created-until', opts.createdUntil);
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.mine) command.push('--mine');
    if (opts.onlyTitle) command.push('--only-title');
    output = join(root, 'feishu', 'drive', `search-${stamp}.md`);
    body = buildDriveSearchMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update drive search ${stamp}`;
  } else if (opts.kind === 'im-chat-list') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'im', '+chat-list', '--format', 'json'];
    if (opts.types) command.push('--types', opts.types);
    if (opts.sortType) command.push('--sort-type', opts.sortType);
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.pageToken) command.push('--page-token', opts.pageToken);
    if (opts.userIdType) command.push('--user-id-type', opts.userIdType);
    if (opts.excludeMuted) command.push('--exclude-muted');
    output = join(root, 'feishu', 'im', `chat-list-${stamp}.md`);
    body = buildImChatListMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update im chat list ${stamp}`;
  } else if (opts.kind === 'im-chat-search') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'im', '+chat-search', '--format', 'json'];
    if (opts.query) command.push('--query', opts.query);
    if (opts.memberIds) command.push('--member-ids', opts.memberIds);
    if (opts.searchTypes) command.push('--search-types', opts.searchTypes);
    if (opts.sortBy) command.push('--sort-by', opts.sortBy);
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.pageToken) command.push('--page-token', opts.pageToken);
    if (opts.excludeMuted) command.push('--exclude-muted');
    if (opts.isManager) command.push('--is-manager');
    output = join(root, 'feishu', 'im', `chat-search-${stamp}.md`);
    body = buildImChatSearchMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update im chat search ${stamp}`;
  } else if (opts.kind === 'im-chat-messages') {
    if (!opts.chatId && !opts.userId) throw new Error(`Usage: ${brand()} feishu pull im-chat-messages --chat-id <oc_xxx> [--sync]`);
    const stamp = minuteStamp();
    command = ['lark-cli', 'im', '+chat-messages-list', '--format', 'json'];
    if (opts.chatId) command.push('--chat-id', opts.chatId);
    if (opts.userId) command.push('--user-id', opts.userId);
    if (opts.start) command.push('--start', opts.start);
    if (opts.end) command.push('--end', opts.end);
    if (opts.sort) command.push('--sort', opts.sort);
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.pageToken) command.push('--page-token', opts.pageToken);
    if (opts.noReactions) command.push('--no-reactions');
    output = join(root, 'feishu', 'im', `chat-messages-${normalizeDocSlug(opts.chatId ?? opts.userId ?? 'chat')}-${stamp}.md`);
    body = buildImChatMessagesMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update im chat messages ${stamp}`;
  } else if (opts.kind === 'im-message-search') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'im', '+messages-search', '--format', 'json'];
    if (opts.query) command.push('--query', opts.query);
    if (opts.chatId) command.push('--chat-id', opts.chatId);
    if (opts.chatType) command.push('--chat-type', opts.chatType);
    if (opts.sender) command.push('--sender', opts.sender);
    if (opts.senderType) command.push('--sender-type', opts.senderType);
    if (opts.excludeSenderType) command.push('--exclude-sender-type', opts.excludeSenderType);
    if (opts.atChatterIds) command.push('--at-chatter-ids', opts.atChatterIds);
    if (opts.includeAttachmentType) command.push('--include-attachment-type', opts.includeAttachmentType);
    if (opts.start) command.push('--start', opts.start);
    if (opts.end) command.push('--end', opts.end);
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.pageToken) command.push('--page-token', opts.pageToken);
    if (opts.pageAll) command.push('--page-all');
    if (opts.pageAll && opts.pageLimit) command.push('--page-limit', opts.pageLimit);
    if (opts.isAtMe) command.push('--is-at-me');
    if (opts.noReactions) command.push('--no-reactions');
    output = join(root, 'feishu', 'im', `message-search-${stamp}.md`);
    body = buildImMessageSearchMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update im message search ${stamp}`;
  } else if (opts.kind === 'im-flags') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'im', '+flag-list', '--format', 'json'];
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.pageToken) command.push('--page-token', opts.pageToken);
    if (opts.pageAll) command.push('--page-all');
    if (opts.pageAll && opts.pageLimit) command.push('--page-limit', opts.pageLimit);
    if (opts.enrichFeedThread === false) command.push('--enrich-feed-thread=false');
    output = join(root, 'feishu', 'im', `flags-${stamp}.md`);
    body = buildImFlagsMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update im flags ${stamp}`;
  } else if (opts.kind === 'wiki-spaces') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'wiki', '+space-list', '--format', 'json'];
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.pageAll) command.push('--page-all');
    if (opts.pageAll && opts.pageLimit) command.push('--page-limit', opts.pageLimit);
    output = join(root, 'feishu', 'wiki', `spaces-${stamp}.md`);
    body = buildWikiSpacesMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update wiki spaces ${stamp}`;
  } else if (opts.kind === 'wiki-nodes') {
    const stamp = minuteStamp();
    const spaceId = opts.spaceId || 'my_library';
    command = ['lark-cli', 'wiki', '+node-list', '--format', 'json', '--space-id', spaceId];
    if (opts.parentNodeToken) command.push('--parent-node-token', opts.parentNodeToken);
    if (opts.pageSize) command.push('--page-size', opts.pageSize);
    if (opts.pageAll) command.push('--page-all');
    if (opts.pageAll && opts.pageLimit) command.push('--page-limit', opts.pageLimit);
    output = join(root, 'feishu', 'wiki', `nodes-${normalizeDocSlug(spaceId)}-${stamp}.md`);
    body = buildWikiNodesMarkdown(stamp, { ...opts, spaceId }, runLark(command));
    commitMessage = `feishu: update wiki nodes ${stamp}`;
  } else if (opts.kind === 'mail-triage') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'mail', '+triage', '--format', 'json', '--max', opts.max ?? '20'];
    if (opts.query) command.push('--query', opts.query);
    if (opts.filter) command.push('--filter', opts.filter);
    if (opts.mailbox) command.push('--mailbox', opts.mailbox);
    if (opts.labels) command.push('--labels');
    output = join(root, 'feishu', 'mail', `triage-${stamp}.md`);
    body = buildMailTriageMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update mail triage ${stamp}`;
  } else if (opts.kind === 'base-tables') {
    if (!opts.baseToken) throw new Error(`Usage: ${brand()} feishu pull base-tables --base-token <token> [--sync]`);
    const stamp = minuteStamp();
    const baseHash = tokenFingerprint(opts.baseToken);
    command = ['lark-cli', 'base', '+table-list', '--base-token', opts.baseToken];
    if (opts.limit) command.push('--limit', opts.limit);
    if (opts.offset) command.push('--offset', opts.offset);
    output = join(root, 'feishu', 'base', `tables-${baseHash}-${stamp}.md`);
    body = buildBaseTablesMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update base tables ${stamp}`;
  } else if (opts.kind === 'base-fields') {
    if (!opts.baseToken || !opts.tableId) throw new Error(`Usage: ${brand()} feishu pull base-fields --base-token <token> --table-id <table> [--sync]`);
    const stamp = minuteStamp();
    command = ['lark-cli', 'base', '+field-list', '--base-token', opts.baseToken, '--table-id', opts.tableId];
    if (opts.limit) command.push('--limit', opts.limit);
    if (opts.offset) command.push('--offset', opts.offset);
    output = join(root, 'feishu', 'base', `fields-${normalizeDocSlug(opts.tableId)}-${stamp}.md`);
    body = buildBaseFieldsMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update base fields ${opts.tableId} ${stamp}`;
  } else if (opts.kind === 'base-records') {
    if (!opts.baseToken || !opts.tableId) throw new Error(`Usage: ${brand()} feishu pull base-records --base-token <token> --table-id <table> [--sync]`);
    const stamp = minuteStamp();
    command = ['lark-cli', 'base', '+record-list', '--format', 'json', '--base-token', opts.baseToken, '--table-id', opts.tableId];
    if (opts.viewId) command.push('--view-id', opts.viewId);
    if (opts.limit) command.push('--limit', opts.limit);
    if (opts.offset) command.push('--offset', opts.offset);
    for (const fieldId of opts.fieldIds ?? []) command.push('--field-id', fieldId);
    output = join(root, 'feishu', 'base', `records-${normalizeDocSlug(opts.tableId)}-${stamp}.md`);
    body = buildBaseRecordsMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update base records ${opts.tableId} ${stamp}`;
  } else if (opts.kind === 'base-search') {
    if (!opts.baseToken || !opts.tableId || !opts.searchJson) {
      throw new Error(`Usage: ${brand()} feishu pull base-search --base-token <token> --table-id <table> --search-json <json> [--sync]`);
    }
    const stamp = minuteStamp();
    command = ['lark-cli', 'base', '+record-search', '--format', 'json', '--base-token', opts.baseToken, '--table-id', opts.tableId, '--json', opts.searchJson];
    output = join(root, 'feishu', 'base', `search-${normalizeDocSlug(opts.tableId)}-${stamp}.md`);
    body = buildBaseSearchMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update base search ${opts.tableId} ${stamp}`;
  } else if (opts.kind === 'approval-tasks') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'approval', 'tasks', 'query', '--format', 'json'];
    if (opts.pageAll) command.push('--page-all');
    if (opts.pageAll && opts.pageLimit) command.push('--page-limit', opts.pageLimit);
    if (opts.params) command.push('--params', opts.params);
    output = join(root, 'feishu', 'approvals', `tasks-${stamp}.md`);
    body = buildApprovalTasksMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update approval tasks ${stamp}`;
  } else if (opts.kind === 'approval-initiated') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'approval', 'instances', 'initiated', '--format', 'json'];
    if (opts.pageAll) command.push('--page-all');
    if (opts.pageAll && opts.pageLimit) command.push('--page-limit', opts.pageLimit);
    if (opts.params) command.push('--params', opts.params);
    output = join(root, 'feishu', 'approvals', `initiated-${stamp}.md`);
    body = buildApprovalInitiatedMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update approval initiated ${stamp}`;
  } else if (opts.kind === 'okr-cycles') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'okr', '+cycle-list', '--format', 'json'];
    if (opts.timeRange) command.push('--time-range', opts.timeRange);
    if (opts.userId) command.push('--user-id', opts.userId);
    if (opts.userIdType) command.push('--user-id-type', opts.userIdType);
    output = join(root, 'feishu', 'okr', `cycles-${stamp}.md`);
    body = buildOkrCyclesMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update okr cycles ${stamp}`;
  } else if (opts.kind === 'okr-cycle-detail') {
    if (!opts.cycleId) throw new Error(`Usage: ${brand()} feishu pull okr-cycle-detail --cycle-id <id> [--sync]`);
    const stamp = minuteStamp();
    command = ['lark-cli', 'okr', '+cycle-detail', '--format', 'json', '--cycle-id', opts.cycleId];
    output = join(root, 'feishu', 'okr', `cycle-${normalizeDocSlug(opts.cycleId)}-${stamp}.md`);
    body = buildOkrCycleDetailMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update okr cycle ${opts.cycleId} ${stamp}`;
  } else if (opts.kind === 'minutes-search') {
    const stamp = minuteStamp();
    command = ['lark-cli', 'minutes', '+search', '--format', 'json'];
    if (opts.query) command.push('--query', opts.query);
    if (opts.start) command.push('--start', opts.start);
    if (opts.end) command.push('--end', opts.end);
    output = join(root, 'feishu', 'minutes', `search-${stamp}.md`);
    body = buildMinutesSearchMarkdown(stamp, opts, runLark(command));
    commitMessage = `feishu: update minutes search ${stamp}`;
  } else {
    throw new Error(`Usage: ${brand()} feishu pull docs-list --file <manifest.tsv> [--sync]`);
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, body, 'utf-8');
  const commit = commitSnapshot(root, output, commitMessage);
  if (opts.sync && commit === 'skipped') {
    throw new Error(`Cannot sync ${root}: it is not a Git mirror. Run ${brand()} feishu setup --path "${root}" first.`);
  }
  if (commit === 'failed') {
    throw new Error(`Could not commit Feishu snapshot in ${root}. Run git -C "${root}" status to inspect the mirror.`);
  }
  return {
    status: 'ok',
    kind: opts.kind,
    path: root,
    output,
    command: command.map((part) => {
      if (part === opts.doc) return '<redacted-doc>';
      if (part === opts.baseToken) return '<redacted-base-token>';
      return part;
    }),
    commit,
  };
}

async function runRefresh(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseRefresh(args);
  const root = await resolveMirrorRoot(engine, opts);
  const snapshots: SnapshotResult[] = [];

  if (
    !opts.agenda &&
    !opts.tasks &&
    !opts.minutesQuery &&
    !opts.driveQuery &&
    !opts.mailQuery &&
    !opts.approvalTasks &&
    !opts.approvalInitiated &&
    !opts.okrCycles &&
    !opts.okrCycleId &&
    !opts.baseTables &&
    !opts.baseFields &&
    !opts.baseRecords &&
    !opts.baseSearch &&
    !opts.imQuery &&
    !opts.imChatId &&
    !opts.imUserId &&
    !opts.imFlags &&
    !opts.wikiSpaces &&
    !opts.wikiSpaceId
  ) {
    throw new Error(`${brand()} feishu refresh has nothing to collect. Enable agenda/tasks or pass --minutes-query, --drive-query, --mail-query, --approval-tasks, --okr-cycles, --base-tables, --base-records, --im-query, --im-chat-id, --wiki-spaces, or --wiki-space-id.`);
  }

  if (opts.agenda) {
    snapshots.push(collectSnapshot(root, {
      kind: 'agenda',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
    }));
  }

  if (opts.tasks) {
    snapshots.push(collectSnapshot(root, {
      kind: 'tasks',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      query: opts.taskQuery,
      complete: opts.taskComplete,
      dueStart: opts.dueStart,
      dueEnd: opts.dueEnd,
    }));
  }

  if (opts.minutesQuery) {
    snapshots.push(collectSnapshot(root, {
      kind: 'minutes-search',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      query: opts.minutesQuery,
      start: opts.minutesStart,
      end: opts.minutesEnd,
    }));
  }

  if (opts.driveQuery) {
    snapshots.push(collectSnapshot(root, {
      kind: 'drive-search',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      query: opts.driveQuery,
      docTypes: opts.driveDocTypes,
      mine: opts.driveMine,
      pageSize: opts.drivePageSize,
    }));
  }

  if (opts.wikiSpaces) {
    snapshots.push(collectSnapshot(root, {
      kind: 'wiki-spaces',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      pageSize: opts.wikiPageSize,
      pageLimit: opts.wikiPageLimit,
      pageAll: opts.wikiPageAll,
    }));
  }

  if (opts.wikiSpaceId) {
    snapshots.push(collectSnapshot(root, {
      kind: 'wiki-nodes',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      spaceId: opts.wikiSpaceId,
      parentNodeToken: opts.wikiParentNodeToken,
      pageSize: opts.wikiPageSize,
      pageLimit: opts.wikiPageLimit,
      pageAll: opts.wikiPageAll,
    }));
  }

  if (opts.mailQuery) {
    snapshots.push(collectSnapshot(root, {
      kind: 'mail-triage',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      query: opts.mailQuery,
      max: opts.mailMax,
      labels: opts.mailLabels,
    }));
  }

  if (opts.approvalTasks) {
    snapshots.push(collectSnapshot(root, {
      kind: 'approval-tasks',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      params: opts.approvalParams,
      pageAll: true,
      pageLimit: '10',
    }));
  }

  if (opts.approvalInitiated) {
    snapshots.push(collectSnapshot(root, {
      kind: 'approval-initiated',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      params: opts.approvalParams,
      pageAll: true,
      pageLimit: '10',
    }));
  }

  if (opts.okrCycles) {
    snapshots.push(collectSnapshot(root, {
      kind: 'okr-cycles',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      timeRange: opts.okrTimeRange,
      userId: opts.okrUserId,
      userIdType: opts.okrUserIdType,
    }));
  }

  if (opts.okrCycleId) {
    snapshots.push(collectSnapshot(root, {
      kind: 'okr-cycle-detail',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      cycleId: opts.okrCycleId,
    }));
  }

  if (opts.baseTables) {
    snapshots.push(collectSnapshot(root, {
      kind: 'base-tables',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      baseToken: opts.baseToken,
      limit: opts.baseLimit,
      offset: opts.baseOffset,
    }));
  }

  if (opts.baseFields) {
    snapshots.push(collectSnapshot(root, {
      kind: 'base-fields',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      baseToken: opts.baseToken,
      tableId: opts.baseTableId,
      limit: opts.baseLimit,
      offset: opts.baseOffset,
    }));
  }

  if (opts.baseRecords) {
    snapshots.push(collectSnapshot(root, {
      kind: 'base-records',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      baseToken: opts.baseToken,
      tableId: opts.baseTableId,
      viewId: opts.baseViewId,
      fieldIds: opts.baseFieldIds,
      limit: opts.baseLimit,
      offset: opts.baseOffset,
    }));
  }

  if (opts.baseSearch) {
    snapshots.push(collectSnapshot(root, {
      kind: 'base-search',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      baseToken: opts.baseToken,
      tableId: opts.baseTableId,
      viewId: opts.baseViewId,
      searchJson: opts.baseSearchJson,
    }));
  }

  if (opts.imQuery) {
    snapshots.push(collectSnapshot(root, {
      kind: 'im-message-search',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      query: opts.imQuery,
      chatId: opts.imChatId,
      start: opts.imStart,
      end: opts.imEnd,
      pageSize: opts.imPageSize,
      pageLimit: opts.imPageLimit,
      pageAll: Boolean(opts.imPageLimit),
    }));
  }

  if (opts.imChatId || opts.imUserId) {
    snapshots.push(collectSnapshot(root, {
      kind: 'im-chat-messages',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      chatId: opts.imChatId,
      userId: opts.imUserId,
      start: opts.imStart,
      end: opts.imEnd,
      pageSize: opts.imPageSize,
    }));
  }

  if (opts.imFlags) {
    snapshots.push(collectSnapshot(root, {
      kind: 'im-flags',
      sourceId: opts.sourceId,
      path: root,
      sync: false,
      noEmbed: opts.noEmbed,
      json: opts.json,
      pageSize: opts.imPageSize,
      pageLimit: opts.imPageLimit,
      pageAll: Boolean(opts.imPageLimit),
    }));
  }

  const syncRun = opts.sync
    ? opts.json
      ? await withCapturedStdout(() => syncFeishuSource(engine, {
          sourceId: opts.sourceId,
          path: root,
          noEmbed: opts.noEmbed,
        }))
      : { result: await syncFeishuSource(engine, {
          sourceId: opts.sourceId,
          path: root,
          noEmbed: opts.noEmbed,
        }), stdout: '' }
    : null;

  const payload = {
    status: 'ok',
    path: root,
    source_id: opts.sourceId,
    snapshots,
    sync: syncRun ? syncRun.result : null,
  };
  const payloadWithLogs = syncRun?.stdout ? { ...payload, sync_stdout: syncRun.stdout } : payload;

  if (opts.json) {
    console.log(JSON.stringify(payloadWithLogs, null, 2));
    return;
  }

  console.log(`Feishu refresh complete: ${root}`);
  for (const snapshot of snapshots) {
    console.log(`  ${snapshot.kind}: ${snapshot.output} (${snapshot.commit})`);
  }
  if (opts.sync) console.log(`  synced source: ${opts.sourceId}`);
  else console.log(`  next: ${brand()} sync --source ${opts.sourceId} --no-embed`);
}

async function fetchFeishuSource(engine: BrainEngine, sourceId: string): Promise<FeishuSourceRow | null> {
  assertValidSourceId(sourceId);
  const rows = await engine.executeRaw<FeishuSourceRow>(
    `SELECT id, name, local_path, last_sync_at, last_commit, config
       FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0] ?? null;
}

function collectSnapshotStatus(root: string | null): SnapshotDomainStatus[] {
  if (!root) return [];
  return FEISHU_STATUS_DIRS.map((rel) => {
    const path = join(root, rel);
    return {
      domain: rel.slice('feishu/'.length),
      path,
      markdown_files: countMarkdownFiles(path),
      latest: latestMarkdownFile(path),
    };
  });
}

function formatSnapshotSummary(snapshots: SnapshotDomainStatus[]): string {
  if (snapshots.length === 0) return 'none';
  const active = snapshots.filter((snapshot) => snapshot.markdown_files > 0);
  if (active.length === 0) return 'none yet';
  return active.map((snapshot) => `${snapshot.domain} ${snapshot.markdown_files}`).join(', ');
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function encodePathForUrl(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function extractAilySourceUrl(content: string, relativePath: string, sourceUrlBase: string): string {
  try {
    const parsed = matter(content);
    const data = parsed.data as Record<string, unknown>;
    for (const key of ['feishu_url', 'source_url', 'url']) {
      if (isHttpUrl(data[key])) return data[key];
    }
  } catch {
    // Fall back to a deterministic synthetic URL when frontmatter is malformed.
  }
  return `${sourceUrlBase}/${encodePathForUrl(relativePath)}`;
}

export function buildAilyAssetTitle(relativePath: string): string {
  const withoutExt = relativePath.replace(/\.md$/i, '');
  const safe = withoutExt
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 96);
  const hash = createHash('sha256').update(relativePath).digest('hex').slice(0, 12);
  return `rbrain-feishu-${safe || 'snapshot'}-${hash}.txt`;
}

export function buildAilyOverviewMarkdown(): string {
  return [
    '# RBrain Feishu Mirror Overview',
    '',
    'This generated note is a concise retrieval target for Aily. Prefer it over raw collector JSON when answering how rbrain-feishu works.',
    '',
    '中文检索关键词：rbrain-feishu 是怎么同步飞书云文档和知识空间的；飞书云文档同步；飞书知识空间同步；Aily 知识库；rbrain feishu aily push-space。',
    '',
    '简短回答：rbrain-feishu 先用 lark-cli 把飞书云文档、Wiki、Drive 搜索结果等数据拉成本地 Markdown 镜像，再用 `rbrain feishu refresh` 同步到本地 RBrain 数据库；如果要让 Aily 自定义智能体消费，则用 `rbrain feishu aily push-space` 把这些 Markdown 快照上传为 Aily 知识空间资产，后续由 Aily 负责 embedding、检索和飞书聊天回复。',
    '',
    '## What rbrain-feishu does',
    '',
    '- `rbrain feishu setup --path ~/rbrain-feishu` creates a local Feishu mirror, starter collector scripts, and registers the mirror as an RBrain source using the `rbrain-feishu` schema pack.',
    '- `rbrain feishu pull ...` collectors call `lark-cli` with the current Feishu user or bot identity and save snapshots as Markdown under `feishu/`.',
    '- `rbrain feishu refresh` runs the daily collectors, usually agenda and incomplete tasks, plus optional Drive, Wiki, Mail, Minutes, Base, IM, Approval, and OKR collectors, then syncs the mirror into the local RBrain database.',
    '- Each snapshot uses YAML frontmatter for routing metadata, followed by the captured JSON or document content.',
    '',
    '## How Feishu cloud documents are mirrored',
    '',
    '- Discovery can use `lark-cli drive +search --format json` for Drive/Wiki/Docx search results.',
    '- Direct document capture can use `rbrain feishu pull doc <url-or-token> <slug>` or `rbrain feishu pull docs-list --file <manifest.tsv>`.',
    '- Wiki discovery can use `lark-cli wiki +space-list --format json` and `lark-cli wiki +node-list ...` through the rbrain Feishu pull commands.',
    '- The mirror stores these captures as deterministic Markdown files such as `feishu/drive/*.md`, `feishu/wiki/*.md`, and `feishu/docs/*.md`.',
    '',
    '## How Aily knowledge space sync works',
    '',
    '- `rbrain feishu aily push-space --space-id knowledge_space_xxx` uploads mirror Markdown snapshots to an Aily Knowledge Space.',
    '- The command uses the Knowledge Space API with `x-api-token` from `RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN` or `AILY_KNOWLEDGE_SPACE_API_TOKEN`.',
    '- The knowledge space id can come from `--space-id`, `RBRAIN_AILY_KNOWLEDGE_SPACE_ID`, or `AILY_KNOWLEDGE_SPACE_ID`.',
    '- For each Markdown snapshot, rbrain creates a deterministic `.txt` knowledge asset title from the relative path and a short hash.',
    '- The uploaded payload includes `knowledge_space_id`, `title`, `source_url`, and base64-encoded UTF-8 content.',
    '- Existing API-created assets with the same title are skipped by default; pass `--replace` to update them.',
    '- The generated asset `rbrain-feishu-overview` is intentionally concise so Aily can answer setup/sync questions without loading noisy raw JSON captures.',
    '',
    '## Responsibility boundary',
    '',
    '- RBrain handles collection, local mirror files, local RBrain sync, and ingestion into Aily Knowledge Space.',
    '- Aily handles embedding, retrieval, model generation, and Feishu channel replies.',
    '- The Knowledge Space API is a management API for assets; it is not the runtime ask/search API for end users.',
    '- In Feishu chat, the Aily custom agent should consume the connected knowledge space through Enterprise Knowledge or Custom Knowledge retrieval.',
    '',
    '## Secret handling',
    '',
    '- Put real Aily tokens in `.env` or the shell environment, not in committed files.',
    '- The generated mirror `.gitignore` ignores `.env` so API tokens and app secrets stay local.',
    '',
  ].join('\n');
}

function collectMarkdownPaths(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownPaths(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path);
    }
  }
  return out;
}

export function collectAilyPushCandidates(
  root: string,
  opts: { limit?: number; sourceUrlBase?: string } = {},
): AilyPushCandidate[] {
  const feishuRoot = join(root, 'feishu');
  const sourceUrlBase = opts.sourceUrlBase ?? AILY_DEFAULT_SOURCE_URL_BASE;
  const files = collectMarkdownPaths(feishuRoot)
    .sort((a, b) => a.localeCompare(b))
    .filter((path) => relative(root, path).replace(/\\/g, '/') !== AILY_OVERVIEW_RELATIVE_PATH);
  const overviewContent = buildAilyOverviewMarkdown();
  const overviewCandidate: AilyPushCandidate = {
    path: join(root, AILY_OVERVIEW_RELATIVE_PATH),
    relative_path: AILY_OVERVIEW_RELATIVE_PATH,
    title: buildAilyAssetTitle(AILY_OVERVIEW_RELATIVE_PATH),
    source_url: `${sourceUrlBase}/${encodePathForUrl(AILY_OVERVIEW_RELATIVE_PATH)}`,
    bytes: Buffer.byteLength(overviewContent, 'utf-8'),
    content_sha256: createHash('sha256').update(overviewContent).digest('hex'),
  };
  const candidates = [overviewCandidate, ...files.map((path) => {
    const content = readFileSync(path, 'utf-8');
    const relativePath = relative(root, path).replace(/\\/g, '/');
    return {
      path,
      relative_path: relativePath,
      title: buildAilyAssetTitle(relativePath),
      source_url: extractAilySourceUrl(content, relativePath, sourceUrlBase),
      bytes: statSync(path).size,
      content_sha256: createHash('sha256').update(content).digest('hex'),
    };
  })];
  return opts.limit ? candidates.slice(0, opts.limit) : candidates;
}

export function buildManagedInlineAssetCandidates(
  assets: ManagedInlineAssetInput[],
  opts: { limit?: number } = {},
): AilyPushCandidate[] {
  const limited = opts.limit ? assets.slice(0, opts.limit) : assets;
  return limited.map((asset, index) => {
    const normalized = normalizeManagedInlineAssetInput(asset, index);
    const sourceUri = normalized.sourceUri;
    const content = normalized.content;
    const normalizedTextUri = normalized.normalizedTextUri ?? sourceUri;
    const title = normalized.ailyAssetTitle ?? buildAilyAssetTitle(normalizedTextUri);
    return {
      path: normalizedTextUri,
      relative_path: normalizedTextUri,
      title,
      source_url: normalized.sourceUrl ?? sourceUri,
      bytes: Buffer.byteLength(content, 'utf-8'),
      content_sha256: createHash('sha256').update(content).digest('hex'),
      content,
    };
  });
}

function readAilyCandidateContent(candidate: AilyPushCandidate): string {
  if (candidate.content !== undefined) return candidate.content;
  if (candidate.relative_path === AILY_OVERVIEW_RELATIVE_PATH) {
    return buildAilyOverviewMarkdown();
  }
  return readFileSync(candidate.path, 'utf-8');
}

function resolveAilyApiToken(tokenEnv: string, env: EnvLookup = process.env): { token: string; source: string } {
  const primary = env[tokenEnv];
  if (primary) return { token: primary, source: tokenEnv };
  if (tokenEnv === AILY_DEFAULT_TOKEN_ENV && env[AILY_FALLBACK_TOKEN_ENV]) {
    return { token: env[AILY_FALLBACK_TOKEN_ENV]!, source: AILY_FALLBACK_TOKEN_ENV };
  }
  throw new Error(
    `Missing Aily knowledge space API token. Set ${tokenEnv}` +
    (tokenEnv === AILY_DEFAULT_TOKEN_ENV ? ` or ${AILY_FALLBACK_TOKEN_ENV}` : '') +
    `, then retry.`,
  );
}

async function parseAilyResponse(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  const objectBody = body && typeof body === 'object' ? body as Record<string, unknown> : { raw: String(body) };
  if (!response.ok) {
    const detail = typeof objectBody.message === 'string' ? objectBody.message : JSON.stringify(objectBody).slice(0, 300);
    throw new Error(`Aily ${operation} failed: HTTP ${response.status} ${detail}`);
  }
  const statusCode = objectBody.status_code ?? objectBody.code;
  if (statusCode !== undefined && String(statusCode) !== '0') {
    const message = typeof objectBody.message === 'string' ? objectBody.message : JSON.stringify(objectBody).slice(0, 300);
    throw new Error(`Aily ${operation} failed: status_code=${String(statusCode)} ${message}`);
  }
  return objectBody;
}

interface AilyAssetRow {
  knowledge_asset_id?: string;
  name?: string;
  title?: string;
  status?: string;
}

function ailyAssetName(asset: AilyAssetRow): string | undefined {
  return asset.name ?? asset.title;
}

async function listAilyKnowledgeAssets(
  opts: { host: string; knowledgeSpaceId: string; token: string; fetchImpl?: FetchLike },
): Promise<AilyAssetRow[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const assets: AilyAssetRow[] = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${opts.host}/ai/api/v1/cognate/openapi/knowledgeSpaces/${opts.knowledgeSpaceId}/knowledgeAssets?page=${page}&page_size=100`;
    const body = await parseAilyResponse(await fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-api-token': opts.token,
        'accept': 'application/json',
      },
    }), 'list knowledge assets');
    const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
    const pageAssets = Array.isArray(data.knowledge_assets) ? data.knowledge_assets as AilyAssetRow[] : [];
    assets.push(...pageAssets);
    if (data.has_more !== true || pageAssets.length === 0) break;
  }
  return assets;
}

async function writeAilyKnowledgeAsset(
  opts: {
    host: string;
    knowledgeSpaceId: string;
    token: string;
    candidate: AilyPushCandidate;
    content: string;
    existing?: AilyAssetRow;
    fetchImpl?: FetchLike;
  },
): Promise<{ id?: string; status?: string; updated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const payload: Record<string, string> = {
    knowledge_space_id: opts.knowledgeSpaceId,
    title: opts.candidate.title,
    source_url: opts.candidate.source_url,
    content: Buffer.from(opts.content, 'utf-8').toString('base64'),
  };
  const existingId = opts.existing?.knowledge_asset_id;
  if (existingId) payload.knowledge_asset_id = existingId;
  const path = existingId
    ? `/ai/api/v1/cognate/openapi/knowledgeSpaces/${opts.knowledgeSpaceId}/knowledgeAssets/${existingId}/content`
    : `/ai/api/v1/cognate/openapi/knowledgeSpaces/${opts.knowledgeSpaceId}/knowledgeAssets/content`;
  const body = await parseAilyResponse(await fetchImpl(`${opts.host}${path}`, {
    method: existingId ? 'PUT' : 'POST',
    headers: {
      'x-api-token': opts.token,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(payload),
  }), existingId ? 'update knowledge asset' : 'create knowledge asset');
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
  const asset = data.knowledge_asset && typeof data.knowledge_asset === 'object'
    ? data.knowledge_asset as AilyAssetRow
    : {};
  return {
    id: asset.knowledge_asset_id ?? existingId,
    status: asset.status,
    updated: Boolean(existingId),
  };
}

export async function pushAilyKnowledgeSpace(opts: {
  root: string;
  host: string;
  knowledgeSpaceId: string;
  token: string;
  sourceUrlBase?: string;
  limit?: number;
  replace?: boolean;
  dryRun?: boolean;
  candidates?: AilyPushCandidate[];
  dryRunExistingAssets?: AilyAssetRow[];
  fetchImpl?: FetchLike;
}): Promise<AilyPushSpaceResult> {
  const candidates = opts.candidates ?? collectAilyPushCandidates(opts.root, {
    limit: opts.limit,
    sourceUrlBase: opts.sourceUrlBase,
  });
  const existingAssets = opts.dryRun
    ? opts.dryRunExistingAssets ?? []
    : await listAilyKnowledgeAssets({
        host: opts.host,
        knowledgeSpaceId: opts.knowledgeSpaceId,
        token: opts.token,
        fetchImpl: opts.fetchImpl,
      });
  const existingByName = new Map<string, AilyAssetRow>();
  for (const asset of existingAssets) {
    const name = ailyAssetName(asset);
    if (name) existingByName.set(name, asset);
  }

  const assets: AilyPushItemResult[] = [];
  for (const candidate of candidates) {
    const existing = existingByName.get(candidate.title);
    if (candidate.bytes > AILY_MAX_ASSET_BYTES) {
      assets.push({ ...candidate, action: 'skipped_oversize', error: 'File exceeds Aily 30MB local file limit.' });
      continue;
    }
    if (opts.dryRun) {
      assets.push({
        ...candidate,
        action: existing
          ? opts.replace ? 'dry_run_update' : 'dry_run_skip_existing'
          : 'dry_run_create',
        knowledge_asset_id: existing?.knowledge_asset_id,
        asset_status: existing?.status,
      });
      continue;
    }
    if (existing && !opts.replace) {
      assets.push({
        ...candidate,
        action: 'skipped_existing',
        knowledge_asset_id: existing.knowledge_asset_id,
        asset_status: existing.status,
      });
      continue;
    }
    try {
      const content = readAilyCandidateContent(candidate);
      const written = await writeAilyKnowledgeAsset({
        host: opts.host,
        knowledgeSpaceId: opts.knowledgeSpaceId,
        token: opts.token,
        candidate,
        content,
        existing,
        fetchImpl: opts.fetchImpl,
      });
      assets.push({
        ...candidate,
        action: written.updated ? 'updated' : 'created',
        knowledge_asset_id: written.id,
        asset_status: written.status,
      });
    } catch (e) {
      assets.push({
        ...candidate,
        action: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const created = assets.filter((asset) => asset.action === 'created').length;
  const updated = assets.filter((asset) => asset.action === 'updated').length;
  const failed = assets.filter((asset) => asset.action === 'failed').length;
  const skipped = assets.length - created - updated - failed;
  return {
    status: failed > 0 ? 'partial' : 'ok',
    host: opts.host,
    knowledge_space_id: opts.knowledgeSpaceId,
    path: opts.root,
    dry_run: Boolean(opts.dryRun),
    replace: Boolean(opts.replace),
    candidates: candidates.length,
    created,
    updated,
    skipped,
    failed,
    assets,
  };
}

function summarizeAilyPushAssets(opts: {
  root: string;
  host: string;
  knowledgeSpaceId: string;
  dryRun: boolean;
  replace: boolean;
  assets: AilyPushItemResult[];
}): AilyPushSpaceResult {
  const created = opts.assets.filter((asset) => asset.action === 'created').length;
  const updated = opts.assets.filter((asset) => asset.action === 'updated').length;
  const failed = opts.assets.filter((asset) => asset.action === 'failed').length;
  const skipped = opts.assets.length - created - updated - failed;
  return {
    status: failed > 0 ? 'partial' : 'ok',
    host: opts.host,
    knowledge_space_id: opts.knowledgeSpaceId,
    path: opts.root,
    dry_run: opts.dryRun,
    replace: opts.replace,
    candidates: opts.assets.length,
    created,
    updated,
    skipped,
    failed,
    assets: opts.assets,
  };
}

function registryAilyAssets(snapshot: ManagedRegistrySnapshot): Map<string, AilyAssetRow> {
  const out = new Map<string, AilyAssetRow>();
  for (const asset of snapshot.assets) {
    if (!asset.aily_asset_id) continue;
    out.set(asset.aily_asset_title, {
      knowledge_asset_id: asset.aily_asset_id,
      name: asset.aily_asset_title,
      status: asset.aily_status ?? undefined,
    });
  }
  return out;
}

function managedObservationFromAilyAsset(asset: AilyPushItemResult): ManagedAssetObservation {
  return {
    source_uri: asset.source_url,
    title: asset.relative_path,
    content_sha256: asset.content_sha256,
    normalized_text_uri: asset.relative_path,
    aily_asset_title: asset.title,
    aily_asset_id: asset.knowledge_asset_id ?? null,
    aily_status: asset.asset_status ?? null,
    action: asset.action,
    error: asset.error,
  };
}

function buildManagedSyncPayload(opts: {
  registryPath: string;
  registryStore: ManagedRegistryStore;
  persisted: boolean;
  syncRun: ManagedSyncRunRow;
  push: AilyPushSpaceResult;
  baseRows: ManagedBaseMirrorRow[];
  baseWrite: ManagedBaseMirrorWriteResult;
}) {
  return {
    status: opts.push.status,
    dry_run: opts.push.dry_run,
    persisted: opts.persisted,
    registry_path: opts.registryPath,
    registry_store: {
      kind: opts.registryStore.kind,
      location: opts.registryStore.location,
    },
    sync_run: opts.syncRun,
    aily: opts.push,
    base_mirror: {
      status: opts.baseWrite.status,
      configured: opts.baseWrite.configured,
      dry_run: opts.baseWrite.dry_run,
      rows: opts.baseRows.length,
      created: opts.baseWrite.created,
      updated: opts.baseWrite.updated,
      failed: opts.baseWrite.failed,
      errors: opts.baseWrite.errors,
      preview: opts.baseRows.slice(0, 20),
    },
  };
}

function printManagedSyncResult(payload: ReturnType<typeof buildManagedSyncPayload>): void {
  console.log(`Feishu managed sync: ${payload.status}`);
  console.log(`  registry: ${payload.registry_path}${payload.persisted ? '' : ' (dry-run, not written)'}`);
  console.log(
    `  run: ${payload.sync_run.id} ${payload.sync_run.status}, ` +
    `${payload.sync_run.assets_seen} seen, ${payload.sync_run.assets_changed} changed, ` +
    `${payload.sync_run.assets_uploaded} uploaded`,
  );
  console.log(
    `  Aily: ${payload.aily.created} created, ${payload.aily.updated} updated, ` +
    `${payload.aily.skipped} skipped, ${payload.aily.failed} failed`,
  );
  console.log(
    `  Base mirror: ${payload.base_mirror.status}, ${payload.base_mirror.rows} rows, ` +
    `${payload.base_mirror.created} created, ${payload.base_mirror.updated} updated, ` +
    `${payload.base_mirror.failed} failed`,
  );
  if (payload.sync_run.error_summary) console.log(`  errors: ${payload.sync_run.error_summary}`);
}

function managedSyncRunSortKey(run: ManagedSyncRunRow): string {
  return run.started_at || run.finished_at || '';
}

function latestManagedSyncRun(snapshot: ManagedRegistrySnapshot): ManagedSyncRunRow | null {
  return snapshot.sync_runs
    .slice()
    .sort((a, b) => managedSyncRunSortKey(b).localeCompare(managedSyncRunSortKey(a)))[0] ?? null;
}

function countManagedAilyStatuses(snapshot: ManagedRegistrySnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const asset of snapshot.assets) {
    const status = asset.aily_status || 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function buildManagedRegistryStatusPayload(opts: {
  snapshot: ManagedRegistrySnapshot;
  registryStore: ManagedRegistryStore;
  schemaEnsured: boolean;
}) {
  const baseRows = buildManagedBaseMirrorRows(opts.snapshot);
  return {
    status: 'ok' as const,
    registry_store: {
      kind: opts.registryStore.kind,
      location: opts.registryStore.location,
      schema_ensured: opts.schemaEnsured,
    },
    counts: {
      sources: opts.snapshot.sources.length,
      assets: opts.snapshot.assets.length,
      sync_runs: opts.snapshot.sync_runs.length,
      base_mirror_rows: baseRows.length,
    },
    aily_statuses: countManagedAilyStatuses(opts.snapshot),
    latest_sync_run: latestManagedSyncRun(opts.snapshot),
    updated_at: opts.snapshot.updated_at,
    base_mirror: {
      preview: baseRows.slice(0, 20),
    },
  };
}

function printManagedRegistryStatusResult(payload: ReturnType<typeof buildManagedRegistryStatusPayload>): void {
  console.log('Feishu managed registry status: ok');
  console.log(`  registry: ${payload.registry_store.kind} ${payload.registry_store.location}`);
  if (payload.registry_store.schema_ensured) console.log('  schema: ensured');
  console.log(
    `  rows: ${payload.counts.sources} sources, ${payload.counts.assets} assets, ` +
    `${payload.counts.sync_runs} sync runs`,
  );
  const latest = payload.latest_sync_run;
  if (latest) {
    console.log(
      `  latest: ${latest.id} ${latest.status}, ${latest.assets_seen} seen, ` +
      `${latest.assets_uploaded} uploaded`,
    );
  } else {
    console.log('  latest: none');
  }
  const statuses = Object.entries(payload.aily_statuses)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  console.log(`  Aily statuses: ${statuses || 'none'}`);
  console.log(`  Base preview rows: ${payload.counts.base_mirror_rows}`);
}

export interface ManagedRegistryStatusJobInput {
  root: string;
  opts: ManagedRegistryStatusOpts;
  storeConfig?: ManagedRegistryStoreConfig;
  createStoreHandle?: typeof createManagedRegistryStoreHandle;
}

export async function runManagedRegistryStatusJob(input: ManagedRegistryStatusJobInput) {
  const storeConfig = input.storeConfig ?? resolveManagedRegistryStoreConfig({
    kind: input.opts.registryStore,
    root: input.root,
    registryPath: input.opts.registryPath,
    registryUrl: input.opts.registryUrl,
    ensureSchema: input.opts.registryEnsureSchema,
  });
  const createStoreHandle = input.createStoreHandle ?? createManagedRegistryStoreHandle;
  const registryHandle = await createStoreHandle(storeConfig);
  try {
    const snapshot = await registryHandle.store.load();
    return buildManagedRegistryStatusPayload({
      snapshot,
      registryStore: registryHandle.store,
      schemaEnsured: storeConfig.ensureSchema,
    });
  } finally {
    await registryHandle.close?.();
  }
}

function buildManagedRegistryProvisionPayload(opts: {
  statusPayload: ReturnType<typeof buildManagedRegistryStatusPayload>;
}) {
  return {
    status: 'ok' as const,
    registry_store: opts.statusPayload.registry_store,
    schema: {
      dialect: 'postgres' as const,
      version: FEISHU_MANAGED_SQL_SCHEMA_VERSION,
      ensured: true,
      tables: [
        'feishu_managed_sources',
        'feishu_managed_assets',
        'feishu_managed_sync_runs',
      ],
    },
    counts: opts.statusPayload.counts,
    aily_statuses: opts.statusPayload.aily_statuses,
    latest_sync_run: opts.statusPayload.latest_sync_run,
    updated_at: opts.statusPayload.updated_at,
  };
}

function printManagedRegistryProvisionResult(payload: ReturnType<typeof buildManagedRegistryProvisionPayload>): void {
  console.log('Feishu managed registry provision: ok');
  console.log(`  registry: ${payload.registry_store.kind} ${payload.registry_store.location}`);
  console.log(`  schema: postgres v${payload.schema.version} ensured`);
  console.log(
    `  rows: ${payload.counts.sources} sources, ${payload.counts.assets} assets, ` +
    `${payload.counts.sync_runs} sync runs`,
  );
}

export interface ManagedRegistryProvisionJobInput {
  root: string;
  opts: ManagedRegistryProvisionOpts;
  storeConfig?: ManagedRegistryStoreConfig;
  createStoreHandle?: typeof createManagedRegistryStoreHandle;
}

export async function runManagedRegistryProvisionJob(input: ManagedRegistryProvisionJobInput) {
  const storeConfig = input.storeConfig ?? resolveManagedRegistryStoreConfig({
    kind: 'postgres',
    root: input.root,
    registryPath: input.opts.registryPath,
    registryUrl: input.opts.registryUrl,
    ensureSchema: true,
  });
  const createStoreHandle = input.createStoreHandle ?? createManagedRegistryStoreHandle;
  const registryHandle = await createStoreHandle(storeConfig);
  try {
    const snapshot = await registryHandle.store.load();
    return buildManagedRegistryProvisionPayload({
      statusPayload: buildManagedRegistryStatusPayload({
        snapshot,
        registryStore: registryHandle.store,
        schemaEnsured: true,
      }),
    });
  } finally {
    await registryHandle.close?.();
  }
}

interface ManagedBaseMirrorWriteResult {
  status: 'preview' | 'ok' | 'partial';
  configured: boolean;
  dry_run: boolean;
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

interface ManagedBaseProvisionResult {
  status: 'dry_run' | 'ok' | 'failed';
  table_name: string;
  table_id: string | null;
  fields: ReturnType<typeof buildManagedBaseTableFieldsJson>;
  command: string[];
  error?: string;
}

function withOptionalFlag(args: string[], name: string, value: string | undefined): string[] {
  return value ? [...args, name, value] : args;
}

function redactCommandError(input: string, secrets: string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out.slice(0, 500);
}

function extractBaseRecordIdFromSearch(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }

  const visit = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    const obj = value as Record<string, unknown>;
    for (const key of ['record_id', 'recordId', 'id']) {
      const candidate = obj[key];
      if (typeof candidate === 'string' && /^rec[a-zA-Z0-9_]+/.test(candidate)) return candidate;
    }
    for (const child of Object.values(obj)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };

  return visit(parsed);
}

function extractBaseTableId(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }

  const visit = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    const obj = value as Record<string, unknown>;
    for (const key of ['table_id', 'tableId', 'id']) {
      const candidate = obj[key];
      if (typeof candidate === 'string' && /^tbl[a-zA-Z0-9_]+/.test(candidate)) return candidate;
    }
    for (const child of Object.values(obj)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };

  return visit(parsed);
}

function redactArgv(argv: string[], secrets: string[]): string[] {
  return argv.map((arg) => {
    let out = arg;
    for (const secret of secrets) {
      if (secret) out = out.split(secret).join('<redacted>');
    }
    return out;
  });
}

function provisionManagedBaseTable(
  opts: ManagedBaseProvisionOpts,
  commandImpl: typeof runLocalCommand = runLocalCommand,
): ManagedBaseProvisionResult {
  const fields = buildManagedBaseTableFieldsJson();
  const token = opts.baseToken ?? '<base-token>';
  let argv = withOptionalFlag([
    'lark-cli',
    'base',
    '+table-create',
    '--base-token',
    token,
    '--name',
    opts.tableName,
    '--fields',
    JSON.stringify(fields),
    '--format',
    'json',
  ], '--as', opts.as);
  const redactedCommand = redactArgv(argv, [opts.baseToken ?? '']);
  if (opts.dryRun) {
    return {
      status: 'dry_run',
      table_name: opts.tableName,
      table_id: null,
      fields,
      command: redactedCommand,
    };
  }
  if (!opts.baseToken) {
    throw new Error(`${brand()} feishu managed provision-base requires --base-token unless --dry-run is set.`);
  }

  argv = redactedCommand.map((arg) => arg === '<redacted>' ? opts.baseToken! : arg);
  const result = commandImpl(argv);
  if (!result.ok) {
    return {
      status: 'failed',
      table_name: opts.tableName,
      table_id: null,
      fields,
      command: redactedCommand,
      error: redactCommandError(result.stderr || result.stdout, [opts.baseToken]),
    };
  }

  return {
    status: 'ok',
    table_name: opts.tableName,
    table_id: extractBaseTableId(result.stdout),
    fields,
    command: redactedCommand,
  };
}

function printManagedBaseTemplate(json: boolean): void {
  const payload = {
    table_name: 'RBrain Managed Assets',
    fields: buildManagedBaseTableFieldsJson(),
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log('RBrain managed Base template');
  console.log(`  table: ${payload.table_name}`);
  for (const field of payload.fields) console.log(`  - ${field.name} (${field.type})`);
}

function printManagedBaseProvisionResult(payload: ManagedBaseProvisionResult): void {
  console.log(`Feishu managed Base provision: ${payload.status}`);
  console.log(`  table: ${payload.table_name}${payload.table_id ? ` (${payload.table_id})` : ''}`);
  console.log(`  fields: ${payload.fields.length}`);
  if (payload.error) console.log(`  error: ${payload.error}`);
}

function mirrorManagedBaseRows(opts: {
  rows: ManagedBaseMirrorRow[];
  baseToken?: string;
  tableId?: string;
  as?: string;
  dryRun: boolean;
  commandImpl?: typeof runLocalCommand;
}): ManagedBaseMirrorWriteResult {
  const configured = Boolean(opts.baseToken && opts.tableId);
  if (!configured || opts.dryRun) {
    return {
      status: configured ? 'ok' : 'preview',
      configured,
      dry_run: opts.dryRun,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    };
  }

  const commandImpl = opts.commandImpl ?? runLocalCommand;
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];
  const baseArgs = ['lark-cli', 'base'];
  for (const row of opts.rows) {
    const searchArgs = withOptionalFlag([
      ...baseArgs,
      '+record-search',
      '--base-token',
      opts.baseToken!,
      '--table-id',
      opts.tableId!,
      '--keyword',
      row.source_uri,
      '--search-field',
      MANAGED_BASE_FIELD_NAMES.sourceUri,
      '--field-id',
      MANAGED_BASE_FIELD_NAMES.sourceUri,
      '--limit',
      '1',
      '--format',
      'json',
    ], '--as', opts.as);
    const search = commandImpl(searchArgs);
    if (!search.ok) {
      failed++;
      errors.push(`${row.source_uri}: search failed: ${redactCommandError(search.stderr || search.stdout, [opts.baseToken!])}`);
      continue;
    }

    const recordId = extractBaseRecordIdFromSearch(search.stdout);
    const fields = buildManagedBaseRecordFields(row);
    let upsertArgs = withOptionalFlag([
      ...baseArgs,
      '+record-upsert',
      '--base-token',
      opts.baseToken!,
      '--table-id',
      opts.tableId!,
      '--json',
      JSON.stringify(fields),
    ], '--as', opts.as);
    upsertArgs = withOptionalFlag(upsertArgs, '--record-id', recordId ?? undefined);
    const upsert = commandImpl(upsertArgs);
    if (!upsert.ok) {
      failed++;
      errors.push(`${row.source_uri}: upsert failed: ${redactCommandError(upsert.stderr || upsert.stdout, [opts.baseToken!])}`);
      continue;
    }
    if (recordId) updated++;
    else created++;
  }

  return {
    status: failed > 0 ? 'partial' : 'ok',
    configured,
    dry_run: false,
    created,
    updated,
    failed,
    errors,
  };
}

type ManagedBaseMirrorRowsImpl = typeof mirrorManagedBaseRows;

type ManagedRefreshStatusMatch = 'id' | 'title' | 'none';

export interface ManagedRefreshStatusAssetResult {
  id: string;
  source_id: string;
  source_uri: string;
  title: string;
  aily_asset_title: string;
  previous_aily_asset_id: string | null;
  current_aily_asset_id: string | null;
  previous_status: string | null;
  current_status: string | null;
  matched: boolean;
  matched_by: ManagedRefreshStatusMatch;
  changed: boolean;
}

function ailyAssetStatus(asset: AilyAssetRow | undefined): string {
  if (!asset) return 'missing';
  return asset.status ?? 'unknown';
}

function indexAilyAssets(assets: AilyAssetRow[]): {
  byId: Map<string, AilyAssetRow>;
  byTitle: Map<string, AilyAssetRow>;
} {
  const byId = new Map<string, AilyAssetRow>();
  const byTitle = new Map<string, AilyAssetRow>();
  for (const asset of assets) {
    if (asset.knowledge_asset_id && !byId.has(asset.knowledge_asset_id)) {
      byId.set(asset.knowledge_asset_id, asset);
    }
    const title = ailyAssetName(asset);
    if (title && !byTitle.has(title)) byTitle.set(title, asset);
  }
  return { byId, byTitle };
}

function refreshManagedRegistryAilyStatuses(opts: {
  snapshot: ManagedRegistrySnapshot;
  sourceId: string;
  ailyAssets: AilyAssetRow[];
  now: string;
  limit?: number;
}): {
  snapshot: ManagedRegistrySnapshot;
  assets: ManagedRefreshStatusAssetResult[];
  checked: number;
  matched: number;
  missing: number;
  updated: number;
  aily_statuses: Record<string, number>;
} {
  const next = cloneManagedRegistry(opts.snapshot);
  const { byId, byTitle } = indexAilyAssets(opts.ailyAssets);
  const targetAssets = next.assets
    .filter((asset) => asset.source_id === opts.sourceId)
    .sort((a, b) => a.source_uri.localeCompare(b.source_uri))
    .slice(0, opts.limit ?? undefined);

  const assets: ManagedRefreshStatusAssetResult[] = [];
  let matched = 0;
  let missing = 0;
  let updated = 0;

  for (const asset of targetAssets) {
    const previousAssetId = asset.aily_asset_id;
    const previousStatus = asset.aily_status;
    let observed: AilyAssetRow | undefined;
    let matchedBy: ManagedRefreshStatusMatch = 'none';
    if (asset.aily_asset_id) {
      observed = byId.get(asset.aily_asset_id);
      if (observed) matchedBy = 'id';
    }
    if (!observed) {
      observed = byTitle.get(asset.aily_asset_title);
      if (observed) matchedBy = 'title';
    }

    const currentAssetId = observed?.knowledge_asset_id ?? asset.aily_asset_id;
    const currentStatus = ailyAssetStatus(observed);
    const changed =
      previousAssetId !== (currentAssetId ?? null) ||
      previousStatus !== currentStatus;
    if (changed) {
      asset.aily_asset_id = currentAssetId ?? null;
      asset.aily_status = currentStatus;
      asset.updated_at = opts.now;
      updated++;
    }
    if (observed) matched++;
    else missing++;
    assets.push({
      id: asset.id,
      source_id: asset.source_id,
      source_uri: asset.source_uri,
      title: asset.title,
      aily_asset_title: asset.aily_asset_title,
      previous_aily_asset_id: previousAssetId,
      current_aily_asset_id: currentAssetId ?? null,
      previous_status: previousStatus,
      current_status: currentStatus,
      matched: Boolean(observed),
      matched_by: matchedBy,
      changed,
    });
  }

  if (updated > 0) next.updated_at = opts.now;
  return {
    snapshot: next,
    assets,
    checked: targetAssets.length,
    matched,
    missing,
    updated,
    aily_statuses: countManagedAilyStatuses(next),
  };
}

function buildManagedRefreshStatusPayload(opts: {
  registryPath: string;
  registryStore: ManagedRegistryStore;
  persisted: boolean;
  dryRun: boolean;
  knowledgeSpaceId: string;
  ailyAssetsSeen: number;
  refresh: ReturnType<typeof refreshManagedRegistryAilyStatuses>;
  baseRows: ManagedBaseMirrorRow[];
  baseWrite: ManagedBaseMirrorWriteResult;
}) {
  return {
    status: opts.refresh.missing > 0 ? 'partial' : 'ok',
    dry_run: opts.dryRun,
    persisted: opts.persisted,
    registry_path: opts.registryPath,
    registry_store: {
      kind: opts.registryStore.kind,
      location: opts.registryStore.location,
    },
    knowledge_space_id: opts.knowledgeSpaceId,
    aily_assets_seen: opts.ailyAssetsSeen,
    checked: opts.refresh.checked,
    matched: opts.refresh.matched,
    missing: opts.refresh.missing,
    updated: opts.refresh.updated,
    aily_statuses: opts.refresh.aily_statuses,
    assets: opts.refresh.assets,
    base_mirror: {
      status: opts.baseWrite.status,
      configured: opts.baseWrite.configured,
      dry_run: opts.baseWrite.dry_run,
      rows: opts.baseRows.length,
      created: opts.baseWrite.created,
      updated: opts.baseWrite.updated,
      failed: opts.baseWrite.failed,
      errors: opts.baseWrite.errors,
      preview: opts.baseRows.slice(0, 20),
    },
  };
}

function printManagedRefreshStatusResult(payload: ReturnType<typeof buildManagedRefreshStatusPayload>): void {
  console.log(`Feishu managed Aily status refresh: ${payload.status}`);
  console.log(`  registry: ${payload.registry_path}${payload.persisted ? '' : ' (not written)'}`);
  console.log(
    `  Aily: ${payload.aily_assets_seen} remote assets, ${payload.checked} checked, ` +
    `${payload.matched} matched, ${payload.missing} missing`,
  );
  const statuses = Object.entries(payload.aily_statuses)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  console.log(`  statuses: ${statuses || 'none'}`);
  console.log(
    `  Base mirror: ${payload.base_mirror.status}, ${payload.base_mirror.rows} rows, ` +
    `${payload.base_mirror.created} created, ${payload.base_mirror.updated} updated, ` +
    `${payload.base_mirror.failed} failed`,
  );
}

export interface ManagedRefreshStatusJobInput {
  root: string;
  opts: ManagedRefreshStatusOpts;
  env: EnvLookup;
  storeConfig?: ManagedRegistryStoreConfig;
  createStoreHandle?: typeof createManagedRegistryStoreHandle;
  mirrorBaseRows?: ManagedBaseMirrorRowsImpl;
  fetchImpl?: FetchLike;
}

export async function runManagedRefreshStatusJob(input: ManagedRefreshStatusJobInput) {
  const storeConfig = input.storeConfig ?? resolveManagedRegistryStoreConfig({
    kind: input.opts.registryStore,
    root: input.root,
    registryPath: input.opts.registryPath,
    registryUrl: input.opts.registryUrl,
    ensureSchema: input.opts.registryEnsureSchema,
  });
  const registryPath = storeConfig.location;
  const createStoreHandle = input.createStoreHandle ?? createManagedRegistryStoreHandle;
  const registryHandle = await createStoreHandle(storeConfig);
  const registryStore = registryHandle.store;
  try {
    const registry = await registryStore.load();
    const sourceAssets = registry.assets.filter((asset) => asset.source_id === input.opts.sourceId);
    const needsToken = sourceAssets.length > 0;
    const token = needsToken
      ? resolveAilyApiToken(input.opts.tokenEnv, input.env)
      : { token: '', source: '(not needed)' };
    const ailyAssets = needsToken
      ? await listAilyKnowledgeAssets({
          host: input.opts.host,
          knowledgeSpaceId: input.opts.knowledgeSpaceId,
          token: token.token,
          fetchImpl: input.fetchImpl,
        })
      : [];
    const refresh = refreshManagedRegistryAilyStatuses({
      snapshot: registry,
      sourceId: input.opts.sourceId,
      ailyAssets,
      now: new Date().toISOString(),
      limit: input.opts.limit,
    });
    if (!input.opts.dryRun && refresh.updated > 0) await registryStore.save(refresh.snapshot);
    const baseRows = buildManagedBaseMirrorRows(refresh.snapshot);
    const mirrorBaseRows = input.mirrorBaseRows ?? mirrorManagedBaseRows;
    const baseWrite = mirrorBaseRows({
      rows: baseRows,
      baseToken: input.opts.baseToken,
      tableId: input.opts.baseTableId,
      as: input.opts.baseAs,
      dryRun: input.opts.dryRun,
    });
    const payload = buildManagedRefreshStatusPayload({
      registryPath,
      registryStore,
      persisted: !input.opts.dryRun && refresh.updated > 0,
      dryRun: input.opts.dryRun,
      knowledgeSpaceId: input.opts.knowledgeSpaceId,
      ailyAssetsSeen: ailyAssets.length,
      refresh,
      baseRows,
      baseWrite,
    });

    return {
      payload,
      tokenSource: token.source,
    };
  } finally {
    await registryHandle.close?.();
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ManagedWaitStatusResultStatus = 'ok' | 'timeout' | 'empty';

function managedWaitStatusDone(
  payload: ReturnType<typeof buildManagedRefreshStatusPayload>,
  targetStatus: string,
): boolean {
  return payload.checked > 0 &&
    payload.missing === 0 &&
    payload.assets.every((asset) => asset.current_status === targetStatus);
}

function buildManagedWaitStatusPayload(opts: {
  status: ManagedWaitStatusResultStatus;
  targetStatus: string;
  attempts: number;
  elapsedMs: number;
  timeoutMs: number;
  intervalMs: number;
  final: ReturnType<typeof buildManagedRefreshStatusPayload>;
}) {
  return {
    status: opts.status,
    target_status: opts.targetStatus,
    attempts: opts.attempts,
    elapsed_ms: opts.elapsedMs,
    timeout_ms: opts.timeoutMs,
    interval_ms: opts.intervalMs,
    final: opts.final,
  };
}

function printManagedWaitStatusResult(payload: ReturnType<typeof buildManagedWaitStatusPayload>): void {
  console.log(`Feishu managed Aily wait-status: ${payload.status}`);
  console.log(
    `  target: ${payload.target_status}, attempts: ${payload.attempts}, ` +
    `elapsed: ${payload.elapsed_ms}ms`,
  );
  console.log(
    `  final: ${payload.final.checked} checked, ${payload.final.matched} matched, ` +
    `${payload.final.missing} missing, ${payload.final.updated} updated`,
  );
  const statuses = Object.entries(payload.final.aily_statuses)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  console.log(`  statuses: ${statuses || 'none'}`);
}

export interface ManagedWaitStatusJobInput {
  root: string;
  opts: ManagedWaitStatusOpts;
  env: EnvLookup;
  storeConfig?: ManagedRegistryStoreConfig;
  createStoreHandle?: typeof createManagedRegistryStoreHandle;
  mirrorBaseRows?: ManagedBaseMirrorRowsImpl;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function runManagedWaitStatusJob(input: ManagedWaitStatusJobInput) {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? sleepMs;
  const start = now();
  let attempts = 0;
  let finalPayload: ReturnType<typeof buildManagedRefreshStatusPayload> | null = null;

  while (true) {
    attempts++;
    const refresh = await runManagedRefreshStatusJob({
      root: input.root,
      opts: input.opts,
      env: input.env,
      storeConfig: input.storeConfig,
      createStoreHandle: input.createStoreHandle,
      mirrorBaseRows: input.mirrorBaseRows,
      fetchImpl: input.fetchImpl,
    });
    finalPayload = refresh.payload;

    if (finalPayload.checked === 0) {
      return buildManagedWaitStatusPayload({
        status: 'empty',
        targetStatus: input.opts.targetStatus,
        attempts,
        elapsedMs: Math.max(0, now() - start),
        timeoutMs: input.opts.timeoutMs,
        intervalMs: input.opts.intervalMs,
        final: finalPayload,
      });
    }

    if (managedWaitStatusDone(finalPayload, input.opts.targetStatus)) {
      return buildManagedWaitStatusPayload({
        status: 'ok',
        targetStatus: input.opts.targetStatus,
        attempts,
        elapsedMs: Math.max(0, now() - start),
        timeoutMs: input.opts.timeoutMs,
        intervalMs: input.opts.intervalMs,
        final: finalPayload,
      });
    }

    const elapsedMs = Math.max(0, now() - start);
    if (elapsedMs >= input.opts.timeoutMs) {
      return buildManagedWaitStatusPayload({
        status: 'timeout',
        targetStatus: input.opts.targetStatus,
        attempts,
        elapsedMs,
        timeoutMs: input.opts.timeoutMs,
        intervalMs: input.opts.intervalMs,
        final: finalPayload,
      });
    }

    await sleep(Math.min(input.opts.intervalMs, input.opts.timeoutMs - elapsedMs));
  }
}

export interface ManagedSyncJobInput {
  root: string;
  opts: ManagedSyncOpts;
  env: EnvLookup;
  assets?: ManagedInlineAssetInput[];
  fetchImpl?: FetchLike;
  storeConfig?: ManagedRegistryStoreConfig;
  createStoreHandle?: typeof createManagedRegistryStoreHandle;
  mirrorBaseRows?: ManagedBaseMirrorRowsImpl;
}

export async function runManagedSyncJob(input: ManagedSyncJobInput) {
  const storeConfig = input.storeConfig ?? resolveManagedRegistryStoreConfig({
    kind: input.opts.registryStore,
    root: input.root,
    registryPath: input.opts.registryPath,
    registryUrl: input.opts.registryUrl,
    ensureSchema: input.opts.registryEnsureSchema,
  });
  const registryPath = storeConfig.location;
  const createStoreHandle = input.createStoreHandle ?? createManagedRegistryStoreHandle;
  const registryHandle = await createStoreHandle(storeConfig);
  const registryStore = registryHandle.store;
  try {
    const registry = await registryStore.load();
    const candidates = input.assets
      ? buildManagedInlineAssetCandidates(input.assets, { limit: input.opts.limit })
      : collectAilyPushCandidates(input.root, {
          limit: input.opts.limit,
          sourceUrlBase: input.opts.sourceUrlBase,
        });
    const previousByTitle = new Map(registry.assets.map((asset) => [asset.aily_asset_title, asset]));
    const unchanged = new Map<string, AilyPushItemResult>();
    const pushCandidates: AilyPushCandidate[] = [];
    const knownExisting = registryAilyAssets(registry);
    const startedAt = new Date().toISOString();

    for (const candidate of candidates) {
      const previous = previousByTitle.get(candidate.title);
      const sameHash = previous?.content_sha256 === candidate.content_sha256;
      if (sameHash && previous?.aily_asset_id && !input.opts.replace) {
        unchanged.set(candidate.relative_path, {
          ...candidate,
          action: input.opts.dryRun ? 'dry_run_skip_existing' : 'skipped_existing',
          knowledge_asset_id: previous.aily_asset_id,
          asset_status: previous.aily_status ?? undefined,
        });
      } else {
        pushCandidates.push(candidate);
      }
    }

    const token = input.opts.dryRun || pushCandidates.length === 0
      ? { token: '', source: '(not needed)' }
      : resolveAilyApiToken(input.opts.tokenEnv, input.env);
    const pushed = pushCandidates.length === 0
      ? summarizeAilyPushAssets({
          root: input.root,
          host: input.opts.host,
          knowledgeSpaceId: input.opts.knowledgeSpaceId,
          dryRun: input.opts.dryRun,
          replace: input.opts.replace,
          assets: [],
        })
      : await pushAilyKnowledgeSpace({
          root: input.root,
          host: input.opts.host,
          knowledgeSpaceId: input.opts.knowledgeSpaceId,
          token: token.token,
          sourceUrlBase: input.opts.sourceUrlBase,
          replace: true,
          dryRun: input.opts.dryRun,
          candidates: pushCandidates,
          dryRunExistingAssets: Array.from(knownExisting.values()),
          fetchImpl: input.fetchImpl,
        });
    const pushedByPath = new Map(pushed.assets.map((asset) => [asset.relative_path, asset]));
    const assets = candidates.map((candidate) => {
      const existing = unchanged.get(candidate.relative_path);
      if (existing) return existing;
      const pushedAsset = pushedByPath.get(candidate.relative_path);
      if (!pushedAsset) {
        return {
          ...candidate,
          action: 'failed' as const,
          error: 'Candidate was not returned by managed Aily push.',
        };
      }
      return pushedAsset;
    });
    const combinedPush = summarizeAilyPushAssets({
      root: input.root,
      host: input.opts.host,
      knowledgeSpaceId: input.opts.knowledgeSpaceId,
      dryRun: input.opts.dryRun,
      replace: input.opts.replace,
      assets,
    });

    const finishedAt = new Date().toISOString();
    const record = recordManagedSyncResult(input.opts.dryRun ? cloneManagedRegistry(registry) : registry, {
      source: {
        id: input.opts.sourceId,
        kind: input.opts.sourceKind,
        name: input.opts.sourceName,
        config_json: {
          mirror_path: input.root,
          registry_path: registryPath,
          registry_store: storeConfig.kind,
          aily_host: input.opts.host,
          aily_knowledge_space_id: input.opts.knowledgeSpaceId,
          source_url_base: input.opts.sourceUrlBase,
          asset_input: input.assets ? 'inline' : 'mirror',
          inline_assets: input.assets?.length,
        },
      },
      trigger: input.opts.trigger,
      started_at: startedAt,
      finished_at: finishedAt,
      assets: assets.map(managedObservationFromAilyAsset),
    });
    if (!input.opts.dryRun) await registryStore.save(record.snapshot);
    const baseRows = buildManagedBaseMirrorRows(record.snapshot);
    const mirrorBaseRows = input.mirrorBaseRows ?? mirrorManagedBaseRows;
    const baseWrite = mirrorBaseRows({
      rows: baseRows,
      baseToken: input.opts.baseToken,
      tableId: input.opts.baseTableId,
      as: input.opts.baseAs,
      dryRun: input.opts.dryRun,
    });
    const payload = buildManagedSyncPayload({
      registryPath,
      registryStore,
      persisted: !input.opts.dryRun,
      syncRun: record.sync_run,
      push: combinedPush,
      baseRows,
      baseWrite,
    });

    return {
      payload,
      tokenSource: token.source,
      pushCandidates: pushCandidates.length,
    };
  } finally {
    await registryHandle.close?.();
  }
}

export type ManagedTriggerAction = 'capabilities' | 'status' | 'sync' | 'refresh-status';

export interface ManagedTriggerRequest {
  action?: ManagedTriggerAction;
  root?: string;
  assets?: ManagedInlineAssetInput[];
  sourceId?: string;
  trigger?: string;
  registry?: {
    store?: ManagedRegistryStoreKind;
    path?: string;
    url?: string;
    ensureSchema?: boolean;
  };
  aily?: {
    host?: string;
    knowledgeSpaceId?: string;
    tokenEnv?: string;
    sourceUrlBase?: string;
    limit?: number;
    replace?: boolean;
    dryRun?: boolean;
  };
  source?: {
    kind?: ManagedSourceKind;
    name?: string;
  };
  base?: {
    token?: string;
    tableId?: string;
    as?: string;
  };
}

export interface ManagedTriggerInput {
  request?: ManagedTriggerRequest;
  env?: EnvLookup;
  createStoreHandle?: typeof createManagedRegistryStoreHandle;
  mirrorBaseRows?: ManagedBaseMirrorRowsImpl;
  fetchImpl?: FetchLike;
}

export interface ManagedTriggerHttpRequest {
  method?: string;
  body?: string | ManagedTriggerRequest | null;
}

export interface ManagedTriggerHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ManagedTriggerTemplateOpts {
  importSpecifier?: string;
  sourceInput?: ManagedSourceInputMode;
}

interface ManagedTriggerTemplateCliOpts extends ManagedTriggerTemplateOpts {
  json: boolean;
}

interface ManagedDeployBundleCliOpts extends ManagedTriggerTemplateOpts {
  outDir: string;
  packageDependency: string;
  force: boolean;
  json: boolean;
}

interface ManagedDeployPlanCliOpts {
  url?: string;
  sourceInput: ManagedSourceInputMode;
  targetStatus: string;
  timeoutMs: number;
  intervalMs: number;
  json: boolean;
}

interface ManagedDeployBundleFileSpec {
  path: string;
  content: string;
}

interface ManagedDeployBundleOpts extends ManagedTriggerTemplateOpts {
  packageDependency?: string;
}

export interface ManagedTriggerProbeOpts {
  action?: ManagedTriggerAction;
  root?: string;
  assets?: ManagedInlineAssetInput[];
  sourceId?: string;
  ensureSchema?: boolean;
  dryRun?: boolean;
  trigger?: string;
}

interface ManagedTriggerProbeCliOpts extends ManagedTriggerProbeOpts {
  url?: string;
  json: boolean;
}

interface ManagedCanaryCliOpts extends ManagedTriggerProbeOpts {
  url: string;
  skipSync: boolean;
  waitStatus: boolean;
  targetStatus: string;
  timeoutMs: number;
  intervalMs: number;
  json: boolean;
}

export type ManagedEnvCheckTarget = 'status' | 'canary' | 'sync';
export type ManagedSourceInputMode = 'mirror' | 'inline';
type ManagedEnvCheckStatus = 'ok' | 'warn' | 'fail';

interface ManagedEnvCheckCliOpts {
  target: ManagedEnvCheckTarget;
  sourceInput: ManagedSourceInputMode;
  json: boolean;
}

export interface ManagedEnvCheckItem {
  id: string;
  status: 'ok' | 'missing' | 'warn';
  required: boolean;
  keys: string[];
  present: string[];
  purpose: string;
  message?: string;
}

export interface ManagedEnvCheckResult {
  status: ManagedEnvCheckStatus;
  target: ManagedEnvCheckTarget;
  source_input: ManagedSourceInputMode;
  checks: ManagedEnvCheckItem[];
  next_steps: string[];
}

export interface ManagedDeployPlanStep {
  id: string;
  title: string;
  status: 'ready' | 'blocked' | 'manual';
  command?: string;
  reason?: string;
  depends_on?: string[];
}

export interface ManagedDeployPlanResult {
  status: 'ready' | 'blocked';
  source_input: ManagedSourceInputMode;
  env_check: ManagedEnvCheckResult;
  trigger_url: string | null;
  missing_required_env_keys: string[];
  steps: ManagedDeployPlanStep[];
  notes: string[];
}

export interface ManagedRuntimeCapabilitiesResult {
  status: 'ok' | 'warn';
  registry: {
    store: ManagedRegistryStoreKind;
    url_present: boolean;
    ensure_schema: boolean;
  };
  env: {
    present: string[];
    base_status_table: 'configured' | 'partial' | 'not_configured';
  };
  checks: {
    mirror_canary: ManagedEnvCheckResult;
    inline_canary: ManagedEnvCheckResult;
  };
  features: string[];
  next_steps: string[];
}

export interface ManagedTriggerProbeSendResult {
  status: 'ok' | 'error';
  url: string;
  request: ManagedTriggerRequest;
  response: {
    status: number;
    content_type: string | null;
    body: string;
    json?: unknown;
  };
}

export type ManagedTriggerCanaryStepName = ManagedTriggerAction | 'wait-status';

export interface ManagedTriggerCanaryStep {
  name: ManagedTriggerCanaryStepName;
  status: 'ok' | 'error' | 'skipped';
  request?: ManagedTriggerRequest;
  response?: ManagedTriggerProbeSendResult['response'];
  reason?: string;
}

export interface ManagedTriggerCanaryResult {
  status: 'ok' | 'error';
  url: string;
  dry_run: boolean;
  steps: ManagedTriggerCanaryStep[];
}

type ManagedTriggerProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

function parseManagedTriggerHttpBody(input: string | ManagedTriggerRequest | null | undefined): ManagedTriggerRequest {
  if (input === undefined || input === null || input === '') return {};
  if (typeof input !== 'string') return input;
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('managed trigger request body must be a JSON object.');
  }
  return parsed as ManagedTriggerRequest;
}

function managedTriggerJsonResponse(status: number, body: unknown): ManagedTriggerHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function managedTriggerHttpErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const pgRedacted = redactDeep(message);
  return redactCommandError(pgRedacted, [
    process.env[MANAGED_REGISTRY_DATABASE_URL_ENV] ?? '',
    process.env[AILY_DEFAULT_TOKEN_ENV] ?? '',
    process.env[AILY_FALLBACK_TOKEN_ENV] ?? '',
  ]);
}

function resolveManagedTriggerRegistry(opts: {
  request?: ManagedTriggerRequest;
  env: EnvLookup;
}): Pick<ManagedRegistryStatusOpts, 'registryPath' | 'registryStore' | 'registryUrl' | 'registryEnsureSchema'> {
  const registryUrl = opts.request?.registry?.url ?? opts.env[MANAGED_REGISTRY_DATABASE_URL_ENV];
  return {
    registryPath: opts.request?.registry?.path,
    registryStore: opts.request?.registry?.store ?? (registryUrl ? 'postgres' : 'json'),
    registryUrl,
    registryEnsureSchema: Boolean(opts.request?.registry?.ensureSchema),
  };
}

function resolveManagedTriggerRoot(opts: {
  action: ManagedTriggerAction;
  request?: ManagedTriggerRequest;
  env: EnvLookup;
  registryStore: ManagedRegistryStoreKind;
}): string {
  const root = opts.request?.root ?? opts.env[MANAGED_MIRROR_ROOT_ENV];
  if (root) return expandPath(root);
  const hasInlineAssets = Array.isArray(opts.request?.assets) && opts.request.assets.length > 0;
  if (opts.action === 'sync' && hasInlineAssets && opts.registryStore === 'postgres') return process.cwd();
  if ((opts.action === 'status' || opts.action === 'refresh-status') && opts.registryStore === 'postgres') return process.cwd();
  throw new Error(`managed trigger ${opts.action} requires request.root.`);
}

function resolveManagedTriggerKnowledgeSpaceId(request: ManagedTriggerRequest | undefined, env: EnvLookup): string {
  return request?.aily?.knowledgeSpaceId ?? env[AILY_DEFAULT_SPACE_ID_ENV] ?? env[AILY_FALLBACK_SPACE_ID_ENV] ?? '';
}

export async function runManagedTrigger(input: ManagedTriggerInput = {}) {
  const request = input.request ?? {};
  const env = input.env ?? process.env;
  const action = request.action ?? 'status';
  const registry = resolveManagedTriggerRegistry({ request, env });
  if (action === 'capabilities') {
    const payload = buildManagedRuntimeCapabilities({ env, registry });
    return {
      action,
      status: payload.status,
      result: payload,
    };
  }
  const inlineAssetsRaw = (request as { assets?: unknown }).assets;
  const inlineAssets = inlineAssetsRaw === undefined
    ? undefined
    : normalizeManagedInlineAssetInputs(inlineAssetsRaw, {
        label: 'managed trigger request.assets',
        allowSingle: false,
        allowEmpty: true,
      });
  if (inlineAssets && action !== 'sync') {
    throw new Error(`managed trigger ${action} does not accept inline assets.`);
  }
  const root = resolveManagedTriggerRoot({ action, request, env, registryStore: registry.registryStore });
  const sourceId = request.sourceId ?? 'feishu';

  if (action === 'status') {
    const opts: ManagedRegistryStatusOpts = {
      path: root,
      sourceId,
      ...registry,
      json: true,
    };
    const payload = await runManagedRegistryStatusJob({
      root,
      opts,
      createStoreHandle: input.createStoreHandle,
    });
    return {
      action,
      status: payload.status,
      result: payload,
    };
  }

  const knowledgeSpaceId = resolveManagedTriggerKnowledgeSpaceId(request, env);
  if (!knowledgeSpaceId) {
    throw new Error(`managed trigger ${action} requires a knowledge space id.`);
  }
  const commonAily = {
    path: root,
    sourceId,
    host: normalizeAilyHost(request.aily?.host ?? env.RBRAIN_AILY_HOST ?? env.AILY_HOST ?? AILY_DEFAULT_HOST),
    knowledgeSpaceId,
    tokenEnv: request.aily?.tokenEnv ?? AILY_DEFAULT_TOKEN_ENV,
    dryRun: request.aily?.dryRun ?? false,
    json: true,
    ...registry,
    baseToken: request.base?.token ?? env[MANAGED_BASE_TOKEN_ENV],
    baseTableId: request.base?.tableId ?? env[MANAGED_BASE_TABLE_ID_ENV],
    baseAs: request.base?.as ?? env[MANAGED_BASE_AS_ENV],
  };

  if (action === 'refresh-status') {
    const opts: ManagedRefreshStatusOpts = {
      ...commonAily,
      limit: request.aily?.limit,
    };
    const job = await runManagedRefreshStatusJob({
      root,
      opts,
      env,
      createStoreHandle: input.createStoreHandle,
      mirrorBaseRows: input.mirrorBaseRows,
      fetchImpl: input.fetchImpl,
    });
    return {
      action,
      status: job.payload.status,
      result: job.payload,
    };
  }

  const opts: ManagedSyncOpts = {
    ...commonAily,
    sourceUrlBase: normalizeAilyHost(request.aily?.sourceUrlBase ?? AILY_DEFAULT_SOURCE_URL_BASE),
    limit: request.aily?.limit,
    replace: request.aily?.replace ?? false,
    trigger: request.trigger ?? 'api',
    sourceKind: request.source?.kind ?? 'manual',
    sourceName: request.source?.name ?? 'Feishu',
  };
  const job = await runManagedSyncJob({
    root,
    opts,
    env,
    assets: inlineAssets,
    fetchImpl: input.fetchImpl,
    createStoreHandle: input.createStoreHandle,
    mirrorBaseRows: input.mirrorBaseRows,
  });
  return {
    action,
    status: job.payload.status,
    result: job.payload,
  };
}

export async function handleManagedTriggerRequest(input: {
  request?: ManagedTriggerHttpRequest;
  env?: EnvLookup;
  createStoreHandle?: typeof createManagedRegistryStoreHandle;
  mirrorBaseRows?: ManagedBaseMirrorRowsImpl;
  fetchImpl?: FetchLike;
} = {}): Promise<ManagedTriggerHttpResponse> {
  const method = (input.request?.method ?? 'POST').toUpperCase();
  if (method !== 'POST') {
    return managedTriggerJsonResponse(405, {
      status: 'error',
      error: `method ${method} is not allowed`,
    });
  }

  try {
    const request = parseManagedTriggerHttpBody(input.request?.body);
    const result = await runManagedTrigger({
      request,
      env: input.env,
      createStoreHandle: input.createStoreHandle,
      mirrorBaseRows: input.mirrorBaseRows,
      fetchImpl: input.fetchImpl,
    });
    return managedTriggerJsonResponse(result.status === 'partial' ? 207 : 200, result);
  } catch (error) {
    return managedTriggerJsonResponse(400, {
      status: 'error',
      error: managedTriggerHttpErrorMessage(error),
    });
  }
}

function parseManagedTriggerTemplate(args: string[]): ManagedTriggerTemplateCliOpts {
  const importSpecifier = parseFlagValue(args, '--import') ?? MANAGED_TRIGGER_TEMPLATE_IMPORT;
  if (!importSpecifier.trim()) {
    throw new Error(`${brand()} feishu managed trigger-template --import cannot be empty.`);
  }
  return {
    importSpecifier,
    sourceInput: parseManagedSourceInputMode(parseFlagValue(args, '--source-input')),
    json: args.includes('--json'),
  };
}

function managedTriggerTemplateEnv(sourceInput: ManagedSourceInputMode): string[] {
  return Array.from(MANAGED_TRIGGER_TEMPLATE_ENV)
    .filter((key) => sourceInput === 'mirror' || key !== MANAGED_MIRROR_ROOT_ENV);
}

export function buildManagedTriggerTemplate(opts: ManagedTriggerTemplateOpts = {}): string {
  const importSpecifier = opts.importSpecifier ?? MANAGED_TRIGGER_TEMPLATE_IMPORT;
  const sourceInput = opts.sourceInput ?? 'mirror';
  const scheduledBody = sourceInput === 'inline'
    ? `export type InlineAsset = {
  sourceUri: string;
  content: string;
  title?: string;
  normalizedTextUri?: string;
  sourceUrl?: string;
  ailyAssetTitle?: string;
};

export type InlineAssetFetcherContext = {
  env: Env;
  trigger: string;
};

export type InlineAssetFetcher = (context: InlineAssetFetcherContext) => Promise<InlineAsset[]> | InlineAsset[];

let configuredInlineAssetFetcher: InlineAssetFetcher | undefined;

export function configureInlineAssetFetcher(fetcher: InlineAssetFetcher): void {
  configuredInlineAssetFetcher = fetcher;
}

function inlineJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function inlineManualRequiredResponse(envOverride: Env | undefined): Response {
  const env = runtimeEnv(envOverride);
  return inlineJsonResponse(501, {
    status: 'manual_required',
    runtime_env_bound: Boolean(envOverride),
    required_env_present: Boolean(
      env.RBRAIN_FEISHU_MANAGED_DATABASE_URL &&
      env.RBRAIN_AILY_KNOWLEDGE_SPACE_ID &&
      env.RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN
    ),
    message: 'Inline scheduled sync must register an InlineAssetFetcher that fetches and normalizes Feishu items.',
  });
}

function inlineNoAssetsResponse(trigger: string): Response {
  return inlineJsonResponse(200, {
    action: 'sync',
    status: 'ok',
    result: {
      status: 'skipped',
      source_input: 'inline',
      trigger,
      assets_seen: 0,
      reason: 'Inline asset fetcher returned no assets.',
    },
  });
}

async function runInlineSync(env: Env, assets: InlineAsset[], trigger = 'api'): Promise<Response> {
  if (Array.isArray(assets) && assets.length === 0) return inlineNoAssetsResponse(trigger);
  const response = await handleManagedTriggerRequest({
    request: {
      method: 'POST',
      body: JSON.stringify({
        action: 'sync',
        trigger,
        registry: postgresRegistry(env),
        aily: {
          knowledgeSpaceId: env.RBRAIN_AILY_KNOWLEDGE_SPACE_ID,
          tokenEnv: 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
        },
        base: {
          token: env.RBRAIN_FEISHU_MANAGED_BASE_TOKEN,
          tableId: env.RBRAIN_FEISHU_MANAGED_BASE_TABLE_ID,
        },
        assets,
      }),
    },
    env,
  });
  return toWebResponse(response);
}

export async function syncInlineAssets(assets: InlineAsset[], trigger = 'api', envOverride?: Env): Promise<Response> {
  return runInlineSync(runtimeEnv(envOverride), assets, trigger);
}

export async function scheduled(envOverride?: Env, fetcherOverride?: InlineAssetFetcher): Promise<Response> {
  const env = runtimeEnv(envOverride);
  const fetcher = fetcherOverride ?? configuredInlineAssetFetcher;
  if (!fetcher) return inlineManualRequiredResponse(envOverride);
  const assets = await fetcher({ env, trigger: 'schedule' });
  return runInlineSync(env, assets, 'schedule');
}`
    : `export async function scheduled(envOverride?: Env): Promise<Response> {
  const env = runtimeEnv(envOverride);
  const response = await handleManagedTriggerRequest({
    request: {
      method: 'POST',
      body: JSON.stringify({
        action: 'sync',
        root: env.RBRAIN_FEISHU_MIRROR_ROOT,
        trigger: 'schedule',
        registry: postgresRegistry(env),
        aily: {
          knowledgeSpaceId: env.RBRAIN_AILY_KNOWLEDGE_SPACE_ID,
          tokenEnv: 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
        },
        base: {
          token: env.RBRAIN_FEISHU_MANAGED_BASE_TOKEN,
          tableId: env.RBRAIN_FEISHU_MANAGED_BASE_TABLE_ID,
        },
      }),
    },
    env,
  });
  return toWebResponse(response);
}`;
  return `import { handleManagedTriggerRequest } from ${JSON.stringify(importSpecifier)};

type Env = Record<string, string | undefined>;

function runtimeEnv(envOverride?: Env): Env {
  if (envOverride) return envOverride;
  const globalWithProcess = globalThis as typeof globalThis & { process?: { env?: Env } };
  return globalWithProcess.process?.env ?? {};
}

function toWebResponse(response: { status: number; headers: Record<string, string>; body: string }): Response {
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

function postgresRegistry(env: Env) {
  return {
    store: 'postgres' as const,
    url: env.RBRAIN_FEISHU_MANAGED_DATABASE_URL,
    ensureSchema: true,
  };
}

export default async function handler(request: Request, envOverride?: Env): Promise<Response> {
  const env = runtimeEnv(envOverride);
  const response = await handleManagedTriggerRequest({
    request: {
      method: request.method,
      body: await request.text(),
    },
    env,
  });
  return toWebResponse(response);
}

export async function capabilities(envOverride?: Env): Promise<Response> {
  const env = runtimeEnv(envOverride);
  const response = await handleManagedTriggerRequest({
    request: {
      method: 'POST',
      body: JSON.stringify({
        action: 'capabilities',
        registry: postgresRegistry(env),
      }),
    },
    env,
  });
  return toWebResponse(response);
}

${scheduledBody}

export async function status(envOverride?: Env): Promise<Response> {
  const env = runtimeEnv(envOverride);
  const response = await handleManagedTriggerRequest({
    request: {
      method: 'POST',
      body: JSON.stringify({
        action: 'status',
        registry: postgresRegistry(env),
      }),
    },
    env,
  });
  return toWebResponse(response);
}

export async function refreshStatus(envOverride?: Env): Promise<Response> {
  const env = runtimeEnv(envOverride);
  const response = await handleManagedTriggerRequest({
    request: {
      method: 'POST',
      body: JSON.stringify({
        action: 'refresh-status',
        registry: postgresRegistry(env),
        aily: {
          knowledgeSpaceId: env.RBRAIN_AILY_KNOWLEDGE_SPACE_ID,
          tokenEnv: 'RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN',
        },
        base: {
          token: env.RBRAIN_FEISHU_MANAGED_BASE_TOKEN,
          tableId: env.RBRAIN_FEISHU_MANAGED_BASE_TABLE_ID,
        },
      }),
    },
    env,
  });
  return toWebResponse(response);
}
`;
}

function buildManagedTriggerTemplatePayload(opts: ManagedTriggerTemplateOpts = {}) {
  const importSpecifier = opts.importSpecifier ?? MANAGED_TRIGGER_TEMPLATE_IMPORT;
  const sourceInput = opts.sourceInput ?? 'mirror';
  return {
    language: 'typescript',
    import_specifier: importSpecifier,
    source_input: sourceInput,
    env: managedTriggerTemplateEnv(sourceInput),
    template: buildManagedTriggerTemplate({ importSpecifier, sourceInput }),
  };
}

function printManagedTriggerTemplate(opts: ManagedTriggerTemplateCliOpts): void {
  const payload = buildManagedTriggerTemplatePayload(opts);
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(payload.template);
}

function parseManagedDeployBundle(args: string[]): ManagedDeployBundleCliOpts {
  const importSpecifier = parseFlagValue(args, '--import') ?? MANAGED_TRIGGER_TEMPLATE_IMPORT;
  if (!importSpecifier.trim()) {
    throw new Error(`${brand()} feishu managed deploy-bundle --import cannot be empty.`);
  }
  const packageDependency = parseFlagValue(args, '--dependency') ?? MANAGED_DEPLOY_PACKAGE_DEPENDENCY;
  assertManagedDeployPackageDependency(packageDependency);
  return {
    outDir: expandPath(parseFlagValue(args, '--out') ?? parseFlagValue(args, '--dir') ?? MANAGED_DEPLOY_BUNDLE_DEFAULT_DIR),
    importSpecifier,
    sourceInput: parseManagedSourceInputMode(parseFlagValue(args, '--source-input')),
    packageDependency,
    force: args.includes('--force'),
    json: args.includes('--json'),
  };
}

function assertManagedDeployPackageDependency(packageDependency: string): void {
  if (!packageDependency.trim()) {
    throw new Error(`${brand()} feishu managed deploy-bundle --dependency cannot be empty.`);
  }
  const normalized = packageDependency.replace(/^git\+/i, '');
  try {
    const parsed = new URL(normalized);
    if (parsed.username || parsed.password || /\/\/[^/\s]+@/.test(normalized)) {
      throw new Error('credentials');
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'credentials') {
      throw new Error(`${brand()} feishu managed deploy-bundle --dependency must not include credentials or tokens.`);
    }
  }
}

function managedPackageNameFromImportSpecifier(importSpecifier: string): string {
  const parts = importSpecifier.split('/').filter(Boolean);
  if (parts.length === 0) return 'gbrain';
  if (parts[0]!.startsWith('@')) return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return parts[0]!;
}

function buildManagedDeployPackageJson(opts: ManagedDeployBundleOpts = {}): string {
  const importSpecifier = opts.importSpecifier ?? MANAGED_TRIGGER_TEMPLATE_IMPORT;
  const packageDependency = opts.packageDependency ?? MANAGED_DEPLOY_PACKAGE_DEPENDENCY;
  assertManagedDeployPackageDependency(packageDependency);
  const packageName = managedPackageNameFromImportSpecifier(importSpecifier);
  return `${JSON.stringify({
    name: 'rbrain-feishu-managed-runtime',
    private: true,
    type: 'module',
    scripts: {
      start: 'bun run feishu-managed-local-server.ts',
      'smoke:local': 'bun run feishu-managed-local-smoke.ts',
    },
    dependencies: {
      [packageName]: packageDependency,
    },
  }, null, 2)}\n`;
}

function buildManagedDeployLocalServer(opts: { sourceInput?: ManagedSourceInputMode } = {}): string {
  const sourceInput = opts.sourceInput ?? 'mirror';
  const inlineFetcherImport = sourceInput === 'inline'
    ? `import './feishu-inline-fetcher.example.ts';
`
    : '';
  return `import handler, { capabilities, refreshStatus, scheduled, status } from './feishu-managed-trigger.ts';
${inlineFetcherImport}

const rawPort = process.env.PORT ?? process.env.RBRAIN_FEISHU_MANAGED_PORT ?? '8787';
const port = Number.parseInt(rawPort, 10);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(\`Invalid managed runtime port: \${rawPort}\`);
}

function localDebugRoute(request: Request): string {
  return new URL(request.url).pathname.replace(/\\/+$/, '') || '/';
}

Bun.serve({
  port,
  async fetch(request) {
    const route = localDebugRoute(request);
    if (route === '/__rbrain/capabilities') return capabilities();
    if (route === '/__rbrain/status') return status();
    if (route === '/__rbrain/scheduled') return scheduled();
    if (route === '/__rbrain/refresh-status') return refreshStatus();
    return handler(request);
  },
});

console.log(\`RBrain Feishu managed runtime listening on http://127.0.0.1:\${port}\`);
console.log('Local debug routes: /__rbrain/capabilities, /__rbrain/status, /__rbrain/scheduled, /__rbrain/refresh-status');
`;
}

function buildManagedDeployLocalSmoke(opts: { sourceInput?: ManagedSourceInputMode } = {}): string {
  const sourceInput = opts.sourceInput ?? 'mirror';
  const imports = sourceInput === 'inline'
    ? `import './feishu-inline-fetcher.example.ts';
import { capabilities, scheduled, status } from './feishu-managed-trigger.ts';
`
    : `import { capabilities, status } from './feishu-managed-trigger.ts';
`;
  const scheduledSmoke = sourceInput === 'inline'
    ? `
  await assertOkResponse('scheduled', await scheduled(), { rejectSkipped: true });
`
    : '';
  return `${imports}
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

async function parseResponseJson(name: string, response: Response): Promise<JsonRecord> {
  const text = await response.text();
  try {
    return asRecord(JSON.parse(text)) ?? {};
  } catch {
    throw new Error(\`\${name} returned non-JSON response: \${text.slice(0, 160)}\`);
  }
}

async function assertOkResponse(
  name: string,
  response: Response,
  opts: { rejectSkipped?: boolean } = {},
): Promise<void> {
  const body = await parseResponseJson(name, response);
  const result = asRecord(body.result);
  const statusValue = typeof body.status === 'string' ? body.status : undefined;
  const resultStatus = typeof result?.status === 'string' ? result.status : undefined;
  if (!response.ok || statusValue === 'error' || statusValue === 'manual_required') {
    throw new Error(\`\${name} failed: \${JSON.stringify(body)}\`);
  }
  if (opts.rejectSkipped && resultStatus === 'skipped') {
    throw new Error(
      \`\${name} skipped without content. Set ${MANAGED_INLINE_SOURCES_JSON_ENV} for local smoke, or replace the generated fetcher with tenant Feishu API logic.\`,
    );
  }
  console.log(\`\${name}: \${response.status} \${statusValue ?? resultStatus ?? 'ok'}\`);
}

async function main(): Promise<void> {
  await assertOkResponse('capabilities', await capabilities());
  await assertOkResponse('status', await status());${scheduledSmoke}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;
}

function buildManagedInlineFetcherExample(): string {
  return `import {
  configureInlineAssetFetcher,
  type InlineAsset,
  type InlineAssetFetcherContext,
} from './feishu-managed-trigger.ts';

type InlineSourceConfig = {
  sourceUri: string;
  title?: string;
  normalizedTextUri?: string;
  sourceUrl?: string;
  ailyAssetTitle?: string;
  inlineText?: string;
};

function parseInlineSources(env: InlineAssetFetcherContext['env']): InlineSourceConfig[] {
  const raw = env.${MANAGED_INLINE_SOURCES_JSON_ENV};
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  const inputs = Array.isArray(parsed) ? parsed : [parsed];
  return inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(\`inline source \${index + 1} must be a JSON object.\`);
    }
    const source = input as Record<string, unknown>;
    const sourceUri = readOptionalString(source, 'sourceUri');
    if (!sourceUri) throw new Error(\`inline source \${index + 1} requires sourceUri.\`);
    return {
      sourceUri,
      title: readOptionalString(source, 'title'),
      normalizedTextUri: readOptionalString(source, 'normalizedTextUri'),
      sourceUrl: readOptionalString(source, 'sourceUrl'),
      ailyAssetTitle: readOptionalString(source, 'ailyAssetTitle'),
      inlineText: readOptionalString(source, 'inlineText'),
    };
  });
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(\`inline source \${key} must be a string.\`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeSourceText(source: InlineSourceConfig, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(\`inline source \${source.sourceUri} returned empty text.\`);
  const title = source.title ?? source.normalizedTextUri ?? source.sourceUri;
  return [
    \`# \${title}\`,
    '',
    \`Source: \${source.sourceUrl ?? source.sourceUri}\`,
    '',
    trimmed,
  ].join('\\n');
}

export function buildInlineAssetFromText(source: InlineSourceConfig, text: string): InlineAsset {
  return {
    sourceUri: source.sourceUri,
    title: source.title,
    normalizedTextUri: source.normalizedTextUri,
    sourceUrl: source.sourceUrl,
    ailyAssetTitle: source.ailyAssetTitle,
    content: normalizeSourceText(source, text),
  };
}

async function readSourceText(_context: InlineAssetFetcherContext, source: InlineSourceConfig): Promise<string> {
  if (source.inlineText) return source.inlineText;
  throw new Error(
    \`inline source \${source.sourceUri} needs readSourceText() to call the tenant Feishu API and return normalized text.\`,
  );
}

export async function fetchInlineAssets(context: InlineAssetFetcherContext): Promise<InlineAsset[]> {
  const sources = parseInlineSources(context.env);
  const assets: InlineAsset[] = [];
  for (const source of sources) {
    const text = await readSourceText(context, source);
    assets.push(buildInlineAssetFromText(source, text));
  }
  return assets;
}

configureInlineAssetFetcher(fetchInlineAssets);
`;
}

function buildManagedDeployEnvExample(sourceInput: ManagedSourceInputMode = 'mirror'): string {
  const mirrorRoot = sourceInput === 'mirror' ? `${MANAGED_MIRROR_ROOT_ENV}=\n` : '';
  const inlineSources = sourceInput === 'inline'
    ? `# Optional local smoke source list for feishu-inline-fetcher.example.ts.
# Replace inlineText with tenant Feishu API fetch logic before production.
${MANAGED_INLINE_SOURCES_JSON_ENV}=[{"sourceUri":"https://feishu.example/doc/smoke","normalizedTextUri":"feishu/docs/smoke.md","inlineText":"Smoke inline text."}]
`
    : '';
  return `# RBrain Feishu managed runtime environment.
# Copy these names into your platform secret/env manager.
# Keep real values out of Git, Base rows, logs, and generated artifacts.

${mirrorRoot}${MANAGED_REGISTRY_DATABASE_URL_ENV}=
${AILY_DEFAULT_SPACE_ID_ENV}=
${AILY_DEFAULT_TOKEN_ENV}=
${MANAGED_BASE_TOKEN_ENV}=
${MANAGED_BASE_TABLE_ID_ENV}=
${inlineSources}
`;
}

function buildManagedDeployReadme(opts: { importSpecifier: string; sourceInput: ManagedSourceInputMode }): string {
  const sourceInputArgs = managedSourceInputArgs(opts.sourceInput);
  const sourceInputLabel = opts.sourceInput;
  const syncProbeCommands = opts.sourceInput === 'inline'
    ? `rbrain feishu managed probe --action sync --asset-json ${shellArg(MANAGED_INLINE_CANARY_ASSET_JSON)} --json
rbrain feishu managed probe --action sync --asset-json ${shellArg(MANAGED_INLINE_CANARY_ASSET_JSON)} --url https://your-runtime.example/trigger --json
rbrain feishu managed canary --asset-json ${shellArg(MANAGED_INLINE_CANARY_ASSET_JSON)} --url https://your-runtime.example/trigger --json
rbrain feishu managed canary --asset-json ${shellArg(MANAGED_INLINE_CANARY_ASSET_JSON)} --url https://your-runtime.example/trigger --no-dry-run --wait-status --json`
    : `rbrain feishu managed probe --action sync --root /tmp/rbrain-feishu --json
rbrain feishu managed probe --action sync --root /tmp/rbrain-feishu --url https://your-runtime.example/trigger --json
rbrain feishu managed probe --action sync --asset-json ${shellArg(MANAGED_INLINE_CANARY_ASSET_JSON)} --url https://your-runtime.example/trigger --json
rbrain feishu managed canary --root /tmp/rbrain-feishu --url https://your-runtime.example/trigger --json
rbrain feishu managed canary --asset-json ${shellArg(MANAGED_INLINE_CANARY_ASSET_JSON)} --url https://your-runtime.example/trigger --json
rbrain feishu managed canary --root /tmp/rbrain-feishu --url https://your-runtime.example/trigger --no-dry-run --wait-status --json`;
  const inlineRuntimeNote = opts.sourceInput === 'inline'
    ? `
Inline bundles do not require \`${MANAGED_MIRROR_ROOT_ENV}\`. The generated
trigger exports \`configureInlineAssetFetcher(fetcher)\` for scheduled runs and
\`syncInlineAssets(assets, trigger, env)\` for manual handoff. Register a fetcher
that uses the Miaoda/server-function platform APIs to fetch Feishu source items
and return normalized \`InlineAsset[]\` objects.
`
    : '';
  const inlineFetcherFile = opts.sourceInput === 'inline'
    ? `- \`feishu-inline-fetcher.example.ts\`: editable inline source fetcher example
  for \`--source-input inline\` bundles.
`
    : '';
  const inlineLocalSmokeNote = opts.sourceInput === 'inline'
    ? `
Inline bundles also import \`feishu-inline-fetcher.example.ts\` from the local
server and local smoke script, so \`bun run smoke:local\` and
\`http://127.0.0.1:8787/__rbrain/scheduled\` exercise the generated fetcher
registration path with \`${MANAGED_INLINE_SOURCES_JSON_ENV}\` before the same
code is moved into a platform scheduled task.

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:8787/__rbrain/scheduled
\`\`\`
`
    : '';
  return `# RBrain Feishu Managed Runtime Bundle

This directory is generated by \`${brand()} feishu managed deploy-bundle\`.
It packages the pieces needed to deploy the managed registry control plane to
Miaoda or another TypeScript server-function runtime.

Source input mode: \`${sourceInputLabel}\`.
${inlineRuntimeNote}

## Files

- \`feishu-managed-trigger.ts\`: HTTP, capabilities, scheduled sync, status,
  and refresh-status entrypoints.
  It imports \`handleManagedTriggerRequest\` from \`${opts.importSpecifier}\`.
${inlineFetcherFile}- \`feishu-managed-local-server.ts\`: local Bun HTTP server for deployment
  smoke tests before uploading the trigger to a platform. It also exposes
  local debug routes for \`capabilities\`, \`status\`, \`scheduled\`, and
  \`refresh-status\`.
- \`feishu-managed-local-smoke.ts\`: direct local function smoke test for the
  generated capabilities/status entrypoints and, in inline mode, the scheduled
  fetcher path.
- \`feishu-managed-registry.sql\`: Postgres DDL for managed sources, assets,
  and sync runs.
- \`package.json\`: runtime dependency manifest that installs the package
  exporting \`${opts.importSpecifier}\`.
- \`.env.example\`: required environment variable names. Put real values in
  the platform secret manager, not in this file.

## Deploy

1. Install dependencies from \`package.json\` in the runtime so
   \`${opts.importSpecifier}\` resolves.
2. Apply \`feishu-managed-registry.sql\` to the target Serverless PG database,
   or run:

\`\`\`bash
rbrain feishu managed provision-registry --registry-url "$RBRAIN_FEISHU_MANAGED_DATABASE_URL" --json
\`\`\`

   The trigger can also create tables by sending \`registry.ensureSchema: true\`.
3. Configure the environment variables from \`.env.example\`.
4. Check the runtime configuration without printing secret values:

\`\`\`bash
rbrain feishu managed env-check --target canary${sourceInputArgs} --env-file .env.example --json
rbrain feishu managed env-check --target sync${sourceInputArgs} --json
rbrain feishu managed deploy-plan${sourceInputArgs} --url https://your-runtime.example/trigger --json
\`\`\`

5. Optional local smoke test before platform deployment:

\`\`\`bash
bun install
bun run smoke:local
bun run start
rbrain feishu managed probe --action capabilities --url http://127.0.0.1:8787/__rbrain/capabilities --json
rbrain feishu managed canary --url http://127.0.0.1:8787 --status-only --json
rbrain feishu managed probe --action status --url http://127.0.0.1:8787/__rbrain/status --json
\`\`\`
${inlineLocalSmokeNote}

6. Deploy \`feishu-managed-trigger.ts\` as the HTTP/manual and scheduled
   server-function entrypoint.
7. Run a capabilities probe, then a status probe, before enabling a full sync:

\`\`\`bash
rbrain feishu managed probe --action capabilities --json
rbrain feishu managed probe --action capabilities --url https://your-runtime.example/trigger --json
rbrain feishu managed probe --action status --json
rbrain feishu managed probe --action status --url https://your-runtime.example/trigger --json
rbrain feishu managed canary --url https://your-runtime.example/trigger --status-only --json
\`\`\`

8. Run a dry-run sync probe and verify:

\`\`\`bash
${syncProbeCommands}
rbrain feishu managed probe --action refresh-status --url https://your-runtime.example/trigger --json
rbrain feishu managed wait-status --registry-url "$RBRAIN_FEISHU_MANAGED_DATABASE_URL" --space-id "$RBRAIN_AILY_KNOWLEDGE_SPACE_ID" --json
\`\`\`

- Serverless PG has rows in \`feishu_managed_sources\`,
  \`feishu_managed_assets\`, and \`feishu_managed_sync_runs\`.
- Aily Knowledge Space receives the asset and the canary wait step or
  \`managed wait-status\` observes it eventually reporting \`successful\`.
- Feishu Base shows the same asset status row when Base env vars are set.
- Refresh-status probes can observe Aily's latest asset status without
  re-uploading unchanged content.

## Runtime Contract

The generated trigger accepts POST JSON shaped like \`ManagedTriggerRequest\`.
It returns JSON with \`action\`, \`status\`, and \`result\`. Errors redact
database URLs and known token env values before returning the response body.
Server-function platforms can pass env/bindings as the second argument to
\`handler(request, env)\`, \`capabilities(env)\`, \`scheduled(env)\`,
\`status(env)\`, and \`refreshStatus(env)\`. Local Bun smoke tests omit that
argument and read \`process.env\` instead.
Inline scheduled sync calls the registered \`InlineAssetFetcher\`. Without one,
it returns \`manual_required\` instead of trying to guess platform-specific
Feishu fetch behavior.
`;
}

export function buildManagedDeployBundleFiles(opts: ManagedDeployBundleOpts = {}): ManagedDeployBundleFileSpec[] {
  const importSpecifier = opts.importSpecifier ?? MANAGED_TRIGGER_TEMPLATE_IMPORT;
  const sourceInput = opts.sourceInput ?? 'mirror';
  const files: ManagedDeployBundleFileSpec[] = [
    {
      path: 'feishu-managed-trigger.ts',
      content: buildManagedTriggerTemplate({ importSpecifier, sourceInput }),
    },
    {
      path: 'feishu-managed-local-server.ts',
      content: buildManagedDeployLocalServer({ sourceInput }),
    },
    {
      path: 'feishu-managed-local-smoke.ts',
      content: buildManagedDeployLocalSmoke({ sourceInput }),
    },
    {
      path: 'feishu-managed-registry.sql',
      content: `${buildManagedRegistrySqlSchema()}\n`,
    },
    {
      path: 'package.json',
      content: buildManagedDeployPackageJson({
        importSpecifier,
        packageDependency: opts.packageDependency,
      }),
    },
    {
      path: '.env.example',
      content: buildManagedDeployEnvExample(sourceInput),
    },
    {
      path: 'README.md',
      content: buildManagedDeployReadme({ importSpecifier, sourceInput }),
    },
  ];
  if (sourceInput === 'inline') {
    files.splice(1, 0, {
      path: 'feishu-inline-fetcher.example.ts',
      content: buildManagedInlineFetcherExample(),
    });
  }
  return files;
}

function writeManagedDeployBundle(opts: ManagedDeployBundleCliOpts) {
  const sourceInput = opts.sourceInput ?? 'mirror';
  const files = buildManagedDeployBundleFiles({
    importSpecifier: opts.importSpecifier,
    sourceInput,
    packageDependency: opts.packageDependency,
  });
  mkdirSync(opts.outDir, { recursive: true });
  const conflicts = files
    .map((file) => join(opts.outDir, file.path))
    .filter((path) => existsSync(path));
  if (conflicts.length > 0 && !opts.force) {
    throw new Error(
      `${brand()} feishu managed deploy-bundle refuses to overwrite existing files: ` +
      `${conflicts.map((path) => relative(process.cwd(), path)).join(', ')}. Pass --force to replace them.`,
    );
  }

  for (const file of files) {
    const target = join(opts.outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf-8');
  }

  return {
    status: 'ok',
    out_dir: opts.outDir,
    import_specifier: opts.importSpecifier,
    source_input: sourceInput,
    package_dependency: opts.packageDependency,
    files: files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf-8'),
    })),
    env: managedTriggerTemplateEnv(sourceInput),
  };
}

function printManagedDeployBundleResult(payload: ReturnType<typeof writeManagedDeployBundle>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Feishu managed deploy bundle: ${payload.status}`);
  console.log(`  out: ${payload.out_dir}`);
  console.log(`  import: ${payload.import_specifier}`);
  console.log(`  source input: ${payload.source_input}`);
  console.log(`  dependency: ${payload.package_dependency}`);
  console.log(`  files:`);
  for (const file of payload.files) console.log(`  - ${file.path} (${file.bytes} bytes)`);
  console.log(`  env:`);
  for (const key of payload.env) console.log(`  - ${key}`);
}

function parseManagedEnvCheckTarget(input: string | undefined): ManagedEnvCheckTarget {
  if (input === undefined || input === 'sync') return 'sync';
  if (input === 'status' || input === 'canary') return input;
  throw new Error(`--target must be one of status, canary, sync`);
}

function parseManagedSourceInputMode(input: string | undefined): ManagedSourceInputMode {
  if (input === undefined || input === 'mirror') return 'mirror';
  if (input === 'inline') return 'inline';
  throw new Error(`--source-input must be one of mirror, inline`);
}

function parseManagedEnvCheck(args: string[]): ManagedEnvCheckCliOpts {
  return {
    target: parseManagedEnvCheckTarget(parseFlagValue(args, '--target')),
    sourceInput: parseManagedSourceInputMode(parseFlagValue(args, '--source-input')),
    json: args.includes('--json'),
  };
}

function parseManagedDeployPlan(args: string[]): ManagedDeployPlanCliOpts {
  const targetStatus = parseFlagValue(args, '--target-status') ?? 'successful';
  if (!targetStatus.trim()) throw new Error('--target-status cannot be empty');
  return {
    url: parseManagedHttpUrl(parseFlagValue(args, '--url'), 'deploy-plan'),
    sourceInput: parseManagedSourceInputMode(parseFlagValue(args, '--source-input')),
    targetStatus,
    timeoutMs: parsePositiveIntFlag(args, '--timeout-ms') ?? 300_000,
    intervalMs: parsePositiveIntFlag(args, '--interval-ms') ?? 15_000,
    json: args.includes('--json'),
  };
}

function hasEnvValue(env: EnvLookup, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function managedEnvAltCheck(opts: {
  id: string;
  keys: string[];
  env: EnvLookup;
  required: boolean;
  purpose: string;
  message?: string;
}): ManagedEnvCheckItem {
  const present = opts.keys.filter((key) => hasEnvValue(opts.env, key));
  return {
    id: opts.id,
    status: present.length > 0 ? 'ok' : opts.required ? 'missing' : 'warn',
    required: opts.required,
    keys: opts.keys,
    present,
    purpose: opts.purpose,
    ...(opts.message ? { message: opts.message } : {}),
  };
}

function managedEnvSingleCheck(opts: {
  id: string;
  key: string;
  env: EnvLookup;
  required: boolean;
  purpose: string;
  message?: string;
}): ManagedEnvCheckItem {
  return managedEnvAltCheck({
    id: opts.id,
    keys: [opts.key],
    env: opts.env,
    required: opts.required,
    purpose: opts.purpose,
    message: opts.message,
  });
}

function buildManagedBaseEnvCheck(env: EnvLookup): ManagedEnvCheckItem {
  const keys = [MANAGED_BASE_TOKEN_ENV, MANAGED_BASE_TABLE_ID_ENV];
  const present = keys.filter((key) => hasEnvValue(env, key));
  const complete = present.length === keys.length;
  return {
    id: 'base_status_table',
    status: present.length === 0 || complete ? 'ok' : 'warn',
    required: false,
    keys,
    present,
    purpose: 'Optional Feishu Base governance/status mirror.',
    ...(present.length > 0 && !complete
      ? { message: `Set both ${MANAGED_BASE_TOKEN_ENV} and ${MANAGED_BASE_TABLE_ID_ENV}, or neither.` }
      : {}),
  };
}

export function buildManagedEnvCheck(opts: {
  env?: EnvLookup;
  target?: ManagedEnvCheckTarget;
  sourceInput?: ManagedSourceInputMode;
} = {}): ManagedEnvCheckResult {
  const env = opts.env ?? process.env;
  const target = opts.target ?? 'sync';
  const sourceInput = opts.sourceInput ?? 'mirror';
  const needsSync = target === 'canary' || target === 'sync';
  const needsAilyToken = target === 'canary' || target === 'sync';
  const checks: ManagedEnvCheckItem[] = [
    managedEnvSingleCheck({
      id: 'serverless_pg',
      key: MANAGED_REGISTRY_DATABASE_URL_ENV,
      env,
      required: true,
      purpose: 'Serverless PG registry store for sources, assets, and sync runs.',
    }),
  ];

  if (needsSync) {
    if (sourceInput === 'mirror') {
      checks.push(
        managedEnvSingleCheck({
          id: 'mirror_root',
          key: MANAGED_MIRROR_ROOT_ENV,
          env,
          required: true,
          purpose: 'Feishu mirror root visible to the deployed runtime.',
        }),
      );
    }
    checks.push(
      managedEnvAltCheck({
        id: 'aily_space',
        keys: [AILY_DEFAULT_SPACE_ID_ENV, AILY_FALLBACK_SPACE_ID_ENV],
        env,
        required: true,
        purpose: 'Aily Knowledge Space that receives managed assets.',
      }),
      managedEnvAltCheck({
        id: 'aily_token',
        keys: [AILY_DEFAULT_TOKEN_ENV, AILY_FALLBACK_TOKEN_ENV],
        env,
        required: needsAilyToken,
        purpose: 'Aily Knowledge Space API token for sync and refresh-status checks.',
      }),
    );
    if (sourceInput === 'inline') {
      checks.push(
        managedEnvSingleCheck({
          id: 'inline_smoke_sources',
          key: MANAGED_INLINE_SOURCES_JSON_ENV,
          env,
          required: false,
          purpose: 'Optional local source list for the generated inline fetcher example.',
          message: `Set ${MANAGED_INLINE_SOURCES_JSON_ENV} when using the generated inline fetcher example for a contentful local scheduled smoke; production fetchers can read Feishu through platform APIs instead.`,
        }),
      );
    }
  }

  checks.push(buildManagedBaseEnvCheck(env));

  const hasMissing = checks.some((check) => check.required && check.status === 'missing');
  const hasWarn = checks.some((check) => check.status === 'warn');
  const status: ManagedEnvCheckStatus = hasMissing ? 'fail' : hasWarn ? 'warn' : 'ok';
  const nextSteps: string[] = [];
  if (hasMissing) {
    nextSteps.push('Set the missing required environment variables in the runtime secret manager.');
  }
  if (target === 'status') {
    nextSteps.push('Run managed canary with --status-only after deploying the trigger.');
  } else if (sourceInput === 'inline') {
    nextSteps.push('Run managed canary with --asset-json sample content before enabling scheduled inline sync.');
  } else if (target === 'canary') {
    nextSteps.push('Run managed canary, then inspect status, dry-run sync, and refresh-status output.');
  } else {
    nextSteps.push('Run managed canary in dry-run mode before enabling --no-dry-run or scheduled sync.');
  }
  if (checks.find((check) => check.id === 'base_status_table')?.status === 'warn') {
    nextSteps.push('Complete or remove the optional Feishu Base status mirror variables.');
  }
  if (checks.find((check) => check.id === 'inline_smoke_sources')?.status === 'warn') {
    nextSteps.push(`Set ${MANAGED_INLINE_SOURCES_JSON_ENV} for the generated inline fetcher example, or replace it with tenant Feishu API fetch logic.`);
  }

  return {
    status,
    target,
    source_input: sourceInput,
    checks,
    next_steps: nextSteps,
  };
}

function managedRuntimeKnownEnvKeys(): string[] {
  return Array.from(new Set([
    ...MANAGED_TRIGGER_TEMPLATE_ENV,
    MANAGED_BASE_AS_ENV,
    MANAGED_INLINE_SOURCES_JSON_ENV,
    MANAGED_REGISTRY_STORE_ENV,
    AILY_FALLBACK_SPACE_ID_ENV,
    AILY_FALLBACK_TOKEN_ENV,
  ])).sort();
}

function managedRuntimeBaseStatus(check: ManagedEnvCheckItem | undefined): ManagedRuntimeCapabilitiesResult['env']['base_status_table'] {
  if (!check || check.present.length === 0) return 'not_configured';
  return check.status === 'warn' ? 'partial' : 'configured';
}

function managedRuntimeMissingRequired(result: ManagedEnvCheckResult): string[] {
  return result.checks
    .filter((check) => check.required && check.status === 'missing')
    .flatMap((check) => check.keys);
}

export function buildManagedRuntimeCapabilities(opts: {
  env?: EnvLookup;
  registry?: Pick<ManagedRegistryStatusOpts, 'registryStore' | 'registryUrl' | 'registryEnsureSchema'>;
} = {}): ManagedRuntimeCapabilitiesResult {
  const env = opts.env ?? process.env;
  const registry = opts.registry ?? resolveManagedTriggerRegistry({ env });
  const mirrorCanary = buildManagedEnvCheck({ env, target: 'canary', sourceInput: 'mirror' });
  const inlineCanary = buildManagedEnvCheck({ env, target: 'canary', sourceInput: 'inline' });
  const baseCheck = mirrorCanary.checks.find((check) => check.id === 'base_status_table');
  const baseStatus = managedRuntimeBaseStatus(baseCheck);
  const present = managedRuntimeKnownEnvKeys().filter((key) => hasEnvValue(env, key));
  const mirrorReady = mirrorCanary.status !== 'fail';
  const inlineReady = inlineCanary.status !== 'fail';
  const features = [
    'http_trigger',
    registry.registryStore === 'postgres' && registry.registryUrl ? 'postgres_registry' : 'json_registry',
    inlineReady ? 'inline_canary_ready' : 'inline_canary_blocked',
    mirrorReady ? 'mirror_canary_ready' : 'mirror_canary_blocked',
    baseStatus === 'configured' ? 'base_status_table' : undefined,
  ].filter((feature): feature is string => Boolean(feature));
  const nextSteps: string[] = [];
  const mirrorMissing = managedRuntimeMissingRequired(mirrorCanary);
  const inlineMissing = managedRuntimeMissingRequired(inlineCanary);
  if (mirrorMissing.length > 0) nextSteps.push(`Mirror canary missing: ${mirrorMissing.join(', ')}.`);
  if (inlineMissing.length > 0) nextSteps.push(`Inline canary missing: ${inlineMissing.join(', ')}.`);
  if (baseStatus === 'partial') {
    nextSteps.push(`Complete or remove ${MANAGED_BASE_TOKEN_ENV} and ${MANAGED_BASE_TABLE_ID_ENV}.`);
  }
  if (!registry.registryUrl && registry.registryStore === 'postgres') {
    nextSteps.push(`Set ${MANAGED_REGISTRY_DATABASE_URL_ENV} before using the Postgres registry.`);
  }

  return {
    status: (mirrorReady || inlineReady) && baseStatus !== 'partial' ? 'ok' : 'warn',
    registry: {
      store: registry.registryStore,
      url_present: Boolean(registry.registryUrl),
      ensure_schema: registry.registryEnsureSchema,
    },
    env: {
      present,
      base_status_table: baseStatus,
    },
    checks: {
      mirror_canary: mirrorCanary,
      inline_canary: inlineCanary,
    },
    features,
    next_steps: nextSteps,
  };
}

function shellArg(value: string): string {
  return JSON.stringify(value);
}

function managedSourceInputArgs(sourceInput: ManagedSourceInputMode): string {
  return sourceInput === 'inline' ? ' --source-input inline' : '';
}

function managedDeployStep(opts: {
  id: string;
  title: string;
  status?: ManagedDeployPlanStep['status'];
  command?: string;
  reason?: string;
  depends_on?: string[];
}): ManagedDeployPlanStep {
  return {
    id: opts.id,
    title: opts.title,
    status: opts.status ?? 'ready',
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.depends_on ? { depends_on: opts.depends_on } : {}),
  };
}

export function buildManagedDeployPlan(opts: {
  env?: EnvLookup;
  url?: string;
  sourceInput?: ManagedSourceInputMode;
  targetStatus?: string;
  timeoutMs?: number;
  intervalMs?: number;
} = {}): ManagedDeployPlanResult {
  const sourceInput = opts.sourceInput ?? 'mirror';
  const envCheck = buildManagedEnvCheck({ env: opts.env, target: 'canary', sourceInput });
  const missingRequiredEnvKeys = envCheck.checks
    .filter((check) => check.required && check.status === 'missing')
    .flatMap((check) => check.keys);
  const hasMissingEnv = missingRequiredEnvKeys.length > 0;
  const triggerUrl = opts.url ? String(redactDeep(opts.url)) : null;
  const triggerUrlArg = triggerUrl ? shellArg(triggerUrl) : shellArg('https://your-runtime.example/trigger');
  const targetStatus = opts.targetStatus ?? 'successful';
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 15_000;
  const waitArgs = `--target-status ${shellArg(targetStatus)} --timeout-ms ${timeoutMs} --interval-ms ${intervalMs}`;
  const sourceInputArgs = managedSourceInputArgs(sourceInput);
  const productionCanaryInput = sourceInput === 'inline'
    ? `--asset-json ${shellArg(MANAGED_INLINE_CANARY_ASSET_JSON)}`
    : `--root "$${MANAGED_MIRROR_ROOT_ENV}"`;
  const localFunctionSmokeCommand = `cd ${shellArg(MANAGED_DEPLOY_BUNDLE_DEFAULT_DIR)} && bun install && bun run smoke:local`;
  const startLocalRuntimeCommand = `cd ${shellArg(MANAGED_DEPLOY_BUNDLE_DEFAULT_DIR)} && bun install && bun run start`;
  const localSmokeCommand = sourceInput === 'inline'
    ? [
        `rbrain feishu managed canary --url http://127.0.0.1:8787 --status-only --json`,
        `curl -fsS -X POST http://127.0.0.1:8787/__rbrain/scheduled`,
      ].join(' && ')
    : `rbrain feishu managed canary --url http://127.0.0.1:8787 --status-only --json`;
  const missingUrlReason = opts.url ? undefined : 'Set --url after deploying the managed trigger HTTP endpoint.';
  const missingEnvReason = hasMissingEnv
    ? `Set required runtime variables first: ${missingRequiredEnvKeys.join(', ')}.`
    : undefined;
  const canRunRemote = !hasMissingEnv && Boolean(opts.url);
  const baseCheck = envCheck.checks.find((check) => check.id === 'base_status_table');
  const baseConfigured = Boolean(
    baseCheck?.present.includes(MANAGED_BASE_TOKEN_ENV)
      && baseCheck.present.includes(MANAGED_BASE_TABLE_ID_ENV),
  );
  const registryMissing = envCheck.checks.find((check) => check.id === 'serverless_pg')?.status
    === 'missing';
  const baseStepStatus: ManagedDeployPlanStep['status'] =
    baseCheck?.status === 'warn' || (baseConfigured && registryMissing)
      ? 'blocked'
      : baseConfigured
        ? 'ready'
        : 'manual';
  const baseStepTitle = baseConfigured
    ? 'Refresh Feishu Base status mirror from the registry'
    : 'Prepare optional Feishu Base status table';
  const baseStepCommand = baseConfigured
    ? [
        `rbrain feishu managed refresh-status --registry-store postgres`,
        `--registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}"`,
        `--base-token "$${MANAGED_BASE_TOKEN_ENV}"`,
        `--base-table-id "$${MANAGED_BASE_TABLE_ID_ENV}"`,
        `--json`,
      ].join(' ')
    : `rbrain feishu managed base-template --json`;
  const baseStepReason = baseCheck?.status === 'warn'
    ? baseCheck.message
    : baseConfigured && registryMissing
      ? `Set ${MANAGED_REGISTRY_DATABASE_URL_ENV} before mirroring Base status from the registry.`
      : baseConfigured
        ? 'Refresh-status can update readable Feishu Base rows without re-uploading unchanged assets.'
        : `Run provision-base, then set ${MANAGED_BASE_TOKEN_ENV} and ${MANAGED_BASE_TABLE_ID_ENV} to enable the governance table.`;

  const steps: ManagedDeployPlanStep[] = [
    managedDeployStep({
      id: 'env-check',
      title: 'Check runtime environment names',
      status: hasMissingEnv ? 'blocked' : 'ready',
      command: `rbrain feishu managed env-check --target canary${sourceInputArgs} --json`,
      reason: missingEnvReason,
    }),
    managedDeployStep({
      id: 'provision-registry',
      title: 'Apply or verify Serverless PG registry schema',
      status: hasMissingEnv ? 'blocked' : 'ready',
      command: `rbrain feishu managed provision-registry --registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}" --json`,
      reason: missingEnvReason,
      depends_on: ['env-check'],
    }),
    managedDeployStep({
      id: 'base-status-table',
      title: baseStepTitle,
      status: baseStepStatus,
      command: baseStepCommand,
      reason: baseStepReason,
      depends_on: ['provision-registry'],
    }),
    managedDeployStep({
      id: 'deploy-trigger',
      title: 'Deploy the generated trigger to Miaoda or a server-function runtime',
      status: 'manual',
      command: `rbrain feishu managed deploy-bundle${sourceInputArgs} --out ${shellArg(MANAGED_DEPLOY_BUNDLE_DEFAULT_DIR)} --json`,
      depends_on: ['provision-registry'],
    }),
    managedDeployStep({
      id: 'local-function-smoke',
      title: sourceInput === 'inline'
        ? 'Run local direct status and inline scheduled function smoke'
        : 'Run local direct status function smoke',
      status: hasMissingEnv ? 'blocked' : 'manual',
      command: localFunctionSmokeCommand,
      reason: missingEnvReason,
      depends_on: ['deploy-trigger'],
    }),
    managedDeployStep({
      id: 'start-local-runtime',
      title: 'Start the generated local runtime in a separate terminal',
      status: 'manual',
      command: startLocalRuntimeCommand,
      depends_on: ['local-function-smoke'],
    }),
    managedDeployStep({
      id: 'local-smoke',
      title: sourceInput === 'inline'
        ? 'Run local status and inline scheduled smoke before platform upload'
        : 'Run local status smoke before platform upload',
      status: hasMissingEnv ? 'blocked' : 'manual',
      command: localSmokeCommand,
      reason: missingEnvReason,
      depends_on: ['start-local-runtime'],
    }),
    managedDeployStep({
      id: 'runtime-capabilities',
      title: 'Probe deployed runtime capabilities and bound env names',
      status: opts.url ? 'ready' : 'blocked',
      command: `rbrain feishu managed probe --action capabilities --url ${triggerUrlArg} --json`,
      reason: missingUrlReason,
      depends_on: ['local-smoke'],
    }),
    managedDeployStep({
      id: 'status-canary',
      title: 'Probe deployed trigger and Serverless PG connectivity',
      status: canRunRemote ? 'ready' : 'blocked',
      command: `rbrain feishu managed canary --url ${triggerUrlArg} --status-only --json`,
      reason: missingEnvReason ?? missingUrlReason,
      depends_on: ['runtime-capabilities'],
    }),
    managedDeployStep({
      id: 'production-canary',
      title: sourceInput === 'inline'
        ? 'Run inline sync canary and wait for Aily asset learning'
        : 'Run real sync and wait for Aily asset learning',
      status: canRunRemote ? 'ready' : 'blocked',
      command: `rbrain feishu managed canary ${productionCanaryInput} --url ${triggerUrlArg} --no-dry-run --wait-status ${waitArgs} --json`,
      reason: missingEnvReason ?? missingUrlReason,
      depends_on: ['status-canary'],
    }),
    managedDeployStep({
      id: 'inspect-registry',
      title: 'Inspect managed registry and Base mirror preview',
      status: hasMissingEnv ? 'blocked' : 'ready',
      command: `rbrain feishu managed status --registry-store postgres --registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}" --json`,
      reason: missingEnvReason,
      depends_on: ['production-canary'],
    }),
    managedDeployStep({
      id: 'agent-answer-check',
      title: 'Ask the Aily custom agent a question covered by the uploaded asset',
      status: 'manual',
      reason: 'Confirm the runtime retrieval path, not only ingestion status.',
      depends_on: ['production-canary'],
    }),
  ];

  const notes = [
    'Commands intentionally reference environment variable names instead of printing secret values.',
    'Manual steps remain manual because Miaoda deployment and Aily agent chat happen outside the local CLI.',
  ];
  if (envCheck.checks.find((check) => check.id === 'base_status_table')?.status === 'warn') {
    notes.push('The optional Feishu Base mirror is incomplete; ingestion can still proceed, but the governance table will not be fully updated.');
  } else if (baseConfigured) {
    notes.push('Feishu Base status mirroring is configured; refresh-status can update the readable governance table without a second content upload.');
  } else {
    notes.push('Feishu Base status mirroring is optional but not configured; use the base-status-table step when a native governance table is required.');
  }
  if (envCheck.checks.find((check) => check.id === 'inline_smoke_sources')?.status === 'warn') {
    notes.push(`Set ${MANAGED_INLINE_SOURCES_JSON_ENV} to make the generated local inline scheduled smoke move sample content; production fetchers can use tenant Feishu APIs instead.`);
  }
  if (sourceInput === 'inline') {
    notes.push('Inline source-input plans use non-sensitive sample content; replace --asset-json with a Feishu item fetched and normalized by the deployed runtime before production scheduling.');
  }

  return {
    status: steps.some((step) => step.status === 'blocked') ? 'blocked' : 'ready',
    source_input: sourceInput,
    env_check: envCheck,
    trigger_url: triggerUrl,
    missing_required_env_keys: missingRequiredEnvKeys,
    steps,
    notes,
  };
}

function printManagedDeployPlanResult(payload: ManagedDeployPlanResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Feishu managed deploy plan: ${payload.status}`);
  console.log(`  source input: ${payload.source_input}`);
  console.log(`  env: ${payload.env_check.status}`);
  console.log(`  trigger url: ${payload.trigger_url ?? 'not set'}`);
  console.log(`  steps:`);
  for (const step of payload.steps) {
    console.log(`  - ${step.id}: ${step.status} - ${step.title}`);
    if (step.command) console.log(`    ${step.command}`);
    if (step.reason) console.log(`    ${step.reason}`);
  }
  if (payload.notes.length > 0) {
    console.log(`  notes:`);
    for (const note of payload.notes) console.log(`  - ${note}`);
  }
}

function printManagedEnvCheckResult(payload: ManagedEnvCheckResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Feishu managed env check: ${payload.status}`);
  console.log(`  target: ${payload.target}`);
  console.log(`  source input: ${payload.source_input}`);
  for (const check of payload.checks) {
    const present = check.present.length > 0 ? check.present.join(', ') : 'none';
    console.log(`  - ${check.id}: ${check.status} (present: ${present})`);
    if (check.message) console.log(`    ${check.message}`);
  }
  if (payload.next_steps.length > 0) {
    console.log(`  next:`);
    for (const step of payload.next_steps) console.log(`  - ${step}`);
  }
}

function parseManagedProbeAction(input: string | undefined): ManagedTriggerAction {
  if (input === undefined || input === 'status') return 'status';
  if (input === 'capabilities') return 'capabilities';
  if (input === 'sync') return 'sync';
  if (input === 'refresh-status') return 'refresh-status';
  throw new Error(`--action must be one of capabilities, status, sync, refresh-status`);
}

function parseManagedHttpUrl(raw: string | undefined, command: string, required = false): string | undefined {
  if (!raw) {
    if (required) throw new Error(`${brand()} feishu managed ${command} requires --url URL.`);
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    throw new Error(`${brand()} feishu managed ${command} --url must be an http(s) URL.`);
  }
  return raw;
}

function parseManagedInlineAssetString(
  obj: Record<string, unknown>,
  key: keyof ManagedInlineAssetInput,
  index: number,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`managed inline asset ${index + 1} ${key} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeManagedInlineAssetInput(raw: unknown, index: number): ManagedInlineAssetInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`managed inline asset ${index + 1} must be a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  const sourceUri = parseManagedInlineAssetString(obj, 'sourceUri', index);
  if (!sourceUri) throw new Error(`managed inline asset ${index + 1} requires sourceUri.`);
  const rawContent = obj.content;
  if (typeof rawContent !== 'string') {
    throw new Error(`managed inline asset ${index + 1} content must be a string.`);
  }
  if (!rawContent.trim()) throw new Error(`managed inline asset ${index + 1} requires non-empty content.`);

  const asset: ManagedInlineAssetInput = {
    sourceUri,
    content: rawContent,
  };
  const title = parseManagedInlineAssetString(obj, 'title', index);
  if (title) asset.title = title;
  const normalizedTextUri = parseManagedInlineAssetString(obj, 'normalizedTextUri', index);
  if (normalizedTextUri) asset.normalizedTextUri = normalizedTextUri;
  const sourceUrl = parseManagedInlineAssetString(obj, 'sourceUrl', index);
  if (sourceUrl) asset.sourceUrl = sourceUrl;
  const ailyAssetTitle = parseManagedInlineAssetString(obj, 'ailyAssetTitle', index);
  if (ailyAssetTitle) asset.ailyAssetTitle = ailyAssetTitle;
  return asset;
}

function normalizeManagedInlineAssetInputs(
  raw: unknown,
  opts: { label?: string; allowSingle?: boolean; allowEmpty?: boolean } = {},
): ManagedInlineAssetInput[] {
  const label = opts.label ?? 'managed inline assets';
  const inputs = Array.isArray(raw)
    ? raw
    : opts.allowSingle === false
      ? undefined
      : [raw];
  if (!inputs) throw new Error(`${label} must be an array.`);
  if (inputs.length === 0 && opts.allowEmpty !== true) {
    throw new Error(`${label} must include at least one asset.`);
  }
  return inputs.map((input, index) => normalizeManagedInlineAssetInput(input, index));
}

function parseManagedInlineAssetJson(raw: string, flagName: string): ManagedInlineAssetInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${flagName} must be valid JSON: ${message}`);
  }
  return normalizeManagedInlineAssetInputs(parsed, { label: flagName });
}

function parseManagedInlineAssetJsonFlags(args: string[]): ManagedInlineAssetInput[] | undefined {
  const rawValues: Array<{ flagName: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const flagName = args[i];
    if (flagName !== '--asset-json' && flagName !== '--assets-json') continue;
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flagName} requires a JSON value.`);
    rawValues.push({ flagName, value });
    i++;
  }
  if (rawValues.length === 0) return undefined;
  return rawValues.flatMap(({ flagName, value }) => parseManagedInlineAssetJson(value, flagName));
}

function parseManagedTriggerProbe(args: string[]): ManagedTriggerProbeCliOpts {
  const action = parseManagedProbeAction(parseFlagValue(args, '--action') ?? parseFlagValue(args, '--type'));
  const assets = parseManagedInlineAssetJsonFlags(args);
  if (assets && action !== 'sync') throw new Error('--asset-json is only supported with --action sync.');
  return {
    action,
    url: parseManagedHttpUrl(parseFlagValue(args, '--url'), 'probe'),
    root: parseFlagValue(args, '--root') ? expandPath(parseFlagValue(args, '--root')!) : undefined,
    assets,
    sourceId: parseFlagValue(args, '--source-id'),
    ensureSchema: !args.includes('--no-ensure-schema'),
    dryRun: !args.includes('--no-dry-run'),
    trigger: parseFlagValue(args, '--trigger') ?? 'probe',
    json: args.includes('--json'),
  };
}

function parseManagedCanary(args: string[]): ManagedCanaryCliOpts {
  const targetStatus = parseFlagValue(args, '--target-status') ?? 'successful';
  if (!targetStatus.trim()) throw new Error('--target-status cannot be empty');
  return {
    action: 'sync',
    url: parseManagedHttpUrl(parseFlagValue(args, '--url'), 'canary', true)!,
    root: parseFlagValue(args, '--root') ? expandPath(parseFlagValue(args, '--root')!) : undefined,
    assets: parseManagedInlineAssetJsonFlags(args),
    sourceId: parseFlagValue(args, '--source-id'),
    ensureSchema: !args.includes('--no-ensure-schema'),
    dryRun: !args.includes('--no-dry-run'),
    trigger: parseFlagValue(args, '--trigger') ?? 'canary',
    skipSync: args.includes('--status-only') || args.includes('--skip-sync'),
    waitStatus: args.includes('--wait-status'),
    targetStatus,
    timeoutMs: parsePositiveIntFlag(args, '--timeout-ms') ?? 300_000,
    intervalMs: parsePositiveIntFlag(args, '--interval-ms') ?? 15_000,
    json: args.includes('--json'),
  };
}

export function buildManagedTriggerProbeRequest(opts: ManagedTriggerProbeOpts = {}): ManagedTriggerRequest {
  const action = opts.action ?? 'status';
  const assets = opts.assets?.length ? opts.assets : undefined;
  if (assets && action !== 'sync') throw new Error('managed probe inline assets are only supported with sync action.');
  const request: ManagedTriggerRequest = {
    action,
    registry: {
      store: 'postgres',
      ensureSchema: opts.ensureSchema ?? true,
    },
  };
  if (opts.sourceId) request.sourceId = opts.sourceId;
  if (opts.root) request.root = opts.root;
  if (action === 'sync') {
    request.trigger = opts.trigger ?? 'probe';
    if (assets) request.assets = assets;
  }
  if (action === 'sync' || action === 'refresh-status') {
    request.aily = {
      dryRun: opts.dryRun ?? true,
    };
  }
  return request;
}

function parseManagedProbeResponseJson(body: string): unknown | undefined {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function redactManagedProbeText(input: string): string {
  return redactCommandError(redactDeep(input), [
    process.env[MANAGED_REGISTRY_DATABASE_URL_ENV] ?? '',
    process.env[AILY_DEFAULT_TOKEN_ENV] ?? '',
    process.env[AILY_FALLBACK_TOKEN_ENV] ?? '',
    process.env[MANAGED_BASE_TOKEN_ENV] ?? '',
  ]);
}

export async function sendManagedTriggerProbe(opts: {
  url: string;
  request: ManagedTriggerRequest;
  fetchImpl?: ManagedTriggerProbeFetch;
}): Promise<ManagedTriggerProbeSendResult> {
  const fetchImpl: ManagedTriggerProbeFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await fetchImpl(opts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.request),
  });
  const body = redactManagedProbeText(await response.text());
  const json = parseManagedProbeResponseJson(body);
  return {
    status: response.ok ? 'ok' : 'error',
    url: redactDeep(opts.url),
    request: opts.request,
    response: {
      status: response.status,
      content_type: response.headers.get('content-type'),
      body,
      ...(json === undefined ? {} : { json }),
    },
  };
}

function managedCanaryStep(name: ManagedTriggerAction, probe: ManagedTriggerProbeSendResult): ManagedTriggerCanaryStep {
  return {
    name,
    status: probe.status,
    request: probe.request,
    response: probe.response,
  };
}

function extractManagedRefreshPayload(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  const result = obj.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  return obj;
}

function managedRefreshProbeReachedTarget(probe: ManagedTriggerProbeSendResult, targetStatus: string): boolean {
  const payload = extractManagedRefreshPayload(probe.response.json);
  if (!payload) return false;
  const checked = typeof payload.checked === 'number' ? payload.checked : 0;
  const missing = typeof payload.missing === 'number' ? payload.missing : Number.POSITIVE_INFINITY;
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  return checked > 0 &&
    missing === 0 &&
    assets.length > 0 &&
    assets.every((asset) => (
      asset &&
      typeof asset === 'object' &&
      !Array.isArray(asset) &&
      (asset as Record<string, unknown>).current_status === targetStatus
    ));
}

export async function runManagedTriggerCanary(opts: {
  url: string;
  root?: string;
  assets?: ManagedInlineAssetInput[];
  sourceId?: string;
  ensureSchema?: boolean;
  dryRun?: boolean;
  trigger?: string;
  skipSync?: boolean;
  waitStatus?: boolean;
  targetStatus?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: ManagedTriggerProbeFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ManagedTriggerCanaryResult> {
  const steps: ManagedTriggerCanaryStep[] = [];
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? sleepMs;
  const capabilitiesRequest = buildManagedTriggerProbeRequest({
    action: 'capabilities',
    sourceId: opts.sourceId,
    ensureSchema: opts.ensureSchema,
  });
  const capabilitiesProbe = await sendManagedTriggerProbe({
    url: opts.url,
    request: capabilitiesRequest,
    fetchImpl: opts.fetchImpl,
  });
  steps.push(managedCanaryStep('capabilities', capabilitiesProbe));

  if (capabilitiesProbe.status !== 'ok') {
    steps.push({
      name: 'status',
      status: 'skipped',
      reason: 'capabilities probe failed',
    });
    steps.push({
      name: 'sync',
      status: 'skipped',
      reason: 'capabilities probe failed',
    });
    return {
      status: 'error',
      url: redactDeep(opts.url),
      dry_run: opts.dryRun ?? true,
      steps,
    };
  }

  const statusRequest = buildManagedTriggerProbeRequest({
    action: 'status',
    sourceId: opts.sourceId,
    ensureSchema: opts.ensureSchema,
  });
  const statusProbe = await sendManagedTriggerProbe({
    url: opts.url,
    request: statusRequest,
    fetchImpl: opts.fetchImpl,
  });
  steps.push(managedCanaryStep('status', statusProbe));

  if (statusProbe.status !== 'ok') {
    steps.push({
      name: 'sync',
      status: 'skipped',
      reason: 'status probe failed',
    });
    return {
      status: 'error',
      url: redactDeep(opts.url),
      dry_run: opts.dryRun ?? true,
      steps,
    };
  }

  if (opts.skipSync) {
    steps.push({
      name: 'sync',
      status: 'skipped',
      reason: 'sync probe skipped by --status-only',
    });
    return {
      status: 'ok',
      url: redactDeep(opts.url),
      dry_run: opts.dryRun ?? true,
      steps,
    };
  }

  const syncRequest = buildManagedTriggerProbeRequest({
    action: 'sync',
    root: opts.root,
    assets: opts.assets,
    sourceId: opts.sourceId,
    ensureSchema: opts.ensureSchema,
    dryRun: opts.dryRun,
    trigger: opts.trigger ?? 'canary',
  });
  const syncProbe = await sendManagedTriggerProbe({
    url: opts.url,
    request: syncRequest,
    fetchImpl: opts.fetchImpl,
  });
  steps.push(managedCanaryStep('sync', syncProbe));

  if (syncProbe.status !== 'ok') {
    steps.push({
      name: 'refresh-status',
      status: 'skipped',
      reason: 'sync probe failed',
    });
    return {
      status: 'error',
      url: redactDeep(opts.url),
      dry_run: opts.dryRun ?? true,
      steps,
    };
  }

  const refreshRequest = buildManagedTriggerProbeRequest({
    action: 'refresh-status',
    root: opts.root,
    sourceId: opts.sourceId,
    ensureSchema: opts.ensureSchema,
    dryRun: opts.dryRun,
  });
  const refreshProbe = await sendManagedTriggerProbe({
    url: opts.url,
    request: refreshRequest,
    fetchImpl: opts.fetchImpl,
  });
  steps.push(managedCanaryStep('refresh-status', refreshProbe));

  if (opts.waitStatus) {
    const targetStatus = opts.targetStatus ?? 'successful';
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const intervalMs = opts.intervalMs ?? 15_000;
    const start = now();
    let latestProbe = refreshProbe;
    let attempts = 1;

    if (latestProbe.status !== 'ok') {
      steps.push({
        name: 'wait-status',
        status: 'skipped',
        request: refreshRequest,
        response: latestProbe.response,
        reason: 'refresh-status probe failed',
      });
      return {
        status: 'error',
        url: redactDeep(opts.url),
        dry_run: opts.dryRun ?? true,
        steps,
      };
    }

    while (!managedRefreshProbeReachedTarget(latestProbe, targetStatus)) {
      const elapsedMs = Math.max(0, now() - start);
      if (elapsedMs >= timeoutMs) {
        steps.push({
          name: 'wait-status',
          status: 'error',
          request: refreshRequest,
          response: latestProbe.response,
          reason: `target ${targetStatus} not reached after ${attempts} refresh attempts`,
        });
        return {
          status: 'error',
          url: redactDeep(opts.url),
          dry_run: opts.dryRun ?? true,
          steps,
        };
      }
      await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
      latestProbe = await sendManagedTriggerProbe({
        url: opts.url,
        request: refreshRequest,
        fetchImpl: opts.fetchImpl,
      });
      attempts++;
      if (latestProbe.status !== 'ok') {
        steps.push({
          name: 'wait-status',
          status: 'error',
          request: refreshRequest,
          response: latestProbe.response,
          reason: `refresh-status probe failed after ${attempts} refresh attempts`,
        });
        return {
          status: 'error',
          url: redactDeep(opts.url),
          dry_run: opts.dryRun ?? true,
          steps,
        };
      }
    }

    steps.push({
      name: 'wait-status',
      status: 'ok',
      request: refreshRequest,
      response: latestProbe.response,
      reason: `target ${targetStatus} reached after ${attempts} refresh attempts`,
    });
    return {
      status: 'ok',
      url: redactDeep(opts.url),
      dry_run: opts.dryRun ?? true,
      steps,
    };
  }

  return {
    status: refreshProbe.status === 'ok' ? 'ok' : 'error',
    url: redactDeep(opts.url),
    dry_run: opts.dryRun ?? true,
    steps,
  };
}

function printManagedTriggerCanaryResult(payload: ManagedTriggerCanaryResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Feishu managed canary: ${payload.status}`);
  console.log(`  url: ${payload.url}`);
  console.log(`  dry-run actions: ${payload.dry_run ? 'yes' : 'no'}`);
  for (const step of payload.steps) {
    const detail = step.response ? `HTTP ${step.response.status}` : step.reason ?? '';
    console.log(`  - ${step.name}: ${step.status}${detail ? ` (${detail})` : ''}`);
  }
}

function printManagedTriggerProbePreview(request: ManagedTriggerRequest, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ status: 'preview', request }, null, 2));
    return;
  }
  console.log(JSON.stringify(request, null, 2));
}

function printManagedTriggerProbeResult(payload: ManagedTriggerProbeSendResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Feishu managed probe: ${payload.status}`);
  console.log(`  url: ${payload.url}`);
  console.log(`  response: HTTP ${payload.response.status}`);
  if (payload.response.body) console.log(payload.response.body);
}

async function runManaged(engine: BrainEngine | undefined, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }
  if (sub === 'base-template') {
    printManagedBaseTemplate(args.includes('--json'));
    return;
  }
  if (sub === 'trigger-template') {
    printManagedTriggerTemplate(parseManagedTriggerTemplate(args.slice(1)));
    return;
  }
  if (sub === 'deploy-bundle') {
    const opts = parseManagedDeployBundle(args.slice(1));
    printManagedDeployBundleResult(writeManagedDeployBundle(opts), opts.json);
    return;
  }
  if (sub === 'env-check') {
    const rawArgs = args.slice(1);
    const opts = parseManagedEnvCheck(rawArgs);
    const payload = buildManagedEnvCheck({
      env: loadAilyEnv(rawArgs),
      target: opts.target,
      sourceInput: opts.sourceInput,
    });
    printManagedEnvCheckResult(payload, opts.json);
    if (payload.status === 'fail') process.exitCode = 1;
    return;
  }
  if (sub === 'deploy-plan') {
    const rawArgs = args.slice(1);
    const opts = parseManagedDeployPlan(rawArgs);
    const payload = buildManagedDeployPlan({
      env: loadAilyEnv(rawArgs),
      url: opts.url,
      sourceInput: opts.sourceInput,
      targetStatus: opts.targetStatus,
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs,
    });
    printManagedDeployPlanResult(payload, opts.json);
    if (payload.status === 'blocked') process.exitCode = 1;
    return;
  }
  if (sub === 'canary') {
    const opts = parseManagedCanary(args.slice(1));
    const payload = await runManagedTriggerCanary(opts);
    printManagedTriggerCanaryResult(payload, opts.json);
    if (payload.status === 'error') process.exitCode = 1;
    return;
  }
  if (sub === 'probe') {
    const opts = parseManagedTriggerProbe(args.slice(1));
    const request = buildManagedTriggerProbeRequest(opts);
    if (!opts.url) {
      printManagedTriggerProbePreview(request, opts.json);
      return;
    }
    const payload = await sendManagedTriggerProbe({ url: opts.url, request });
    printManagedTriggerProbeResult(payload, opts.json);
    if (payload.status === 'error') process.exitCode = 1;
    return;
  }
  if (sub === 'sql-schema') {
    const sql = buildManagedRegistrySqlSchema();
    if (args.includes('--json')) {
      console.log(JSON.stringify({
        schema_version: FEISHU_MANAGED_SQL_SCHEMA_VERSION,
        dialect: 'postgres',
        sql,
      }, null, 2));
    } else {
      console.log(sql);
    }
    return;
  }
  if (sub === 'provision-registry') {
    const rawArgs = args.slice(1);
    const opts = parseManagedRegistryProvision(rawArgs, loadAilyEnv(rawArgs));
    const root = await resolveManagedRegistryRoot(engine, opts, 'provision-registry');
    const storeConfig = resolveManagedRegistryStoreConfig({
      kind: opts.registryStore,
      root,
      registryPath: opts.registryPath,
      registryUrl: opts.registryUrl,
      ensureSchema: true,
    });
    const payload = await runManagedRegistryProvisionJob({ root, opts, storeConfig });
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else printManagedRegistryProvisionResult(payload);
    return;
  }
  if (sub === 'provision-base') {
    const payload = provisionManagedBaseTable(parseManagedBaseProvision(args.slice(1)));
    if (args.includes('--json')) console.log(JSON.stringify(payload, null, 2));
    else printManagedBaseProvisionResult(payload);
    if (payload.status === 'failed') process.exitCode = 1;
    return;
  }
  if (sub === 'status') {
    const rawArgs = args.slice(1);
    const initialOpts = parseManagedRegistryStatus(rawArgs, loadAilyEnv(rawArgs), { requireRegistryUrl: false });
    const root = await resolveManagedRegistryRoot(engine, initialOpts, 'status');
    const env = loadAilyEnv(rawArgs, root);
    const opts = parseManagedRegistryStatus(rawArgs, env);
    const storeConfig = resolveManagedRegistryStoreConfig({
      kind: opts.registryStore,
      root,
      registryPath: opts.registryPath,
      registryUrl: opts.registryUrl,
      ensureSchema: opts.registryEnsureSchema,
    });
    const payload = await runManagedRegistryStatusJob({ root, opts, storeConfig });
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else printManagedRegistryStatusResult(payload);
    return;
  }
  if (sub === 'refresh-status') {
    const rawArgs = args.slice(1);
    const initialOpts = parseManagedRefreshStatus(rawArgs, loadAilyEnv(rawArgs), {
      requireKnowledgeSpaceId: false,
      requireRegistryUrl: false,
    });
    const root = await resolveManagedRegistryRoot(engine, initialOpts, 'refresh-status');
    const env = loadAilyEnv(rawArgs, root);
    const opts = parseManagedRefreshStatus(rawArgs, env);
    const storeConfig = resolveManagedRegistryStoreConfig({
      kind: opts.registryStore,
      root,
      registryPath: opts.registryPath,
      registryUrl: opts.registryUrl,
      ensureSchema: opts.registryEnsureSchema,
    });
    const job = await runManagedRefreshStatusJob({
      root,
      opts,
      env,
      storeConfig,
    });
    if (opts.json) {
      console.log(JSON.stringify(job.payload, null, 2));
    } else {
      printManagedRefreshStatusResult(job.payload);
      if (job.payload.checked > 0) console.log(`  token source: ${job.tokenSource}`);
    }
    if (job.payload.status === 'partial' || job.payload.base_mirror.failed > 0) process.exitCode = 1;
    return;
  }
  if (sub === 'wait-status') {
    const rawArgs = args.slice(1);
    const initialOpts = parseManagedWaitStatus(rawArgs, loadAilyEnv(rawArgs), {
      requireKnowledgeSpaceId: false,
      requireRegistryUrl: false,
    });
    const root = await resolveManagedRegistryRoot(engine, initialOpts, 'wait-status');
    const env = loadAilyEnv(rawArgs, root);
    const opts = parseManagedWaitStatus(rawArgs, env);
    const storeConfig = resolveManagedRegistryStoreConfig({
      kind: opts.registryStore,
      root,
      registryPath: opts.registryPath,
      registryUrl: opts.registryUrl,
      ensureSchema: opts.registryEnsureSchema,
    });
    const payload = await runManagedWaitStatusJob({
      root,
      opts,
      env,
      storeConfig,
    });
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else printManagedWaitStatusResult(payload);
    if (payload.status !== 'ok' || payload.final.base_mirror.failed > 0) process.exitCode = 1;
    return;
  }
  if (sub !== 'sync') {
    throw new Error(`Usage: ${brand()} feishu managed <sync|refresh-status|wait-status|status|base-template|trigger-template|deploy-bundle|deploy-plan|env-check|probe|canary|provision-registry|provision-base|sql-schema> [options]`);
  }

  const rawArgs = args.slice(1);
  const initialOpts = parseManagedSync(rawArgs, loadAilyEnv(rawArgs), {
    requireKnowledgeSpaceId: false,
    requireRegistryUrl: false,
  });
  const root = await resolveManagedRegistryRoot(engine, initialOpts, 'sync');
  const env = loadAilyEnv(rawArgs, root);
  const opts = parseManagedSync(rawArgs, env);
  const storeConfig = resolveManagedRegistryStoreConfig({
    kind: opts.registryStore,
    root,
    registryPath: opts.registryPath,
    registryUrl: opts.registryUrl,
    ensureSchema: opts.registryEnsureSchema,
  });
  const job = await runManagedSyncJob({
    root,
    opts,
    env,
    storeConfig,
  });

  if (opts.json) {
    console.log(JSON.stringify(job.payload, null, 2));
  } else {
    printManagedSyncResult(job.payload);
    if (!opts.dryRun && job.pushCandidates > 0) console.log(`  token source: ${job.tokenSource}`);
  }
  if (job.payload.aily.failed > 0 || job.payload.base_mirror.failed > 0) process.exitCode = 1;
}

function printStatusResult(payload: {
  status: 'ok' | 'warn';
  source: {
    id: string;
    registered: boolean;
    name: string | null;
    local_path: string | null;
    federated: boolean;
    schema_pack: string | null;
    last_sync_at: string | null;
    last_commit: string | null;
  };
  mirror: {
    path: string | null;
    exists: boolean;
    git: MirrorGitInspection;
    snapshots: SnapshotDomainStatus[];
  };
  lark_cli: { ok: boolean; version: string | null; error?: string };
  schema: { ok: boolean; name: string | null; version: string | null; error?: string };
  next: string[];
}): void {
  console.log('RBrain Feishu status');
  console.log(`  overall: ${payload.status}`);
  console.log(
    `  source: ${payload.source.registered ? 'registered' : 'missing'} ` +
    `(${payload.source.id})`,
  );
  if (payload.source.registered) {
    console.log(`  source path: ${payload.source.local_path ?? '(none)'}`);
    console.log(`  last sync: ${payload.source.last_sync_at ?? 'never'}`);
  }
  console.log(`  mirror: ${payload.mirror.path ?? '(unknown)'} ${payload.mirror.exists ? 'exists' : 'missing'}`);
  console.log(
    `  git: ${payload.mirror.git.state}` +
    (payload.mirror.git.head ? ` @ ${payload.mirror.git.head}` : '') +
    (payload.mirror.git.dirty_files ? `, dirty files ${payload.mirror.git.dirty_files}` : ''),
  );
  console.log(`  snapshots: ${formatSnapshotSummary(payload.mirror.snapshots)}`);
  console.log(`  lark-cli: ${payload.lark_cli.ok ? 'ok' : 'warn'} ${payload.lark_cli.version ?? payload.lark_cli.error ?? ''}`.trimEnd());
  console.log(
    `  schema: ${payload.schema.ok ? 'ok' : 'warn'} ` +
    (payload.schema.name ? `${payload.schema.name} v${payload.schema.version ?? 'unknown'}` : payload.schema.error ?? ''),
  );
  if (payload.next.length > 0) {
    console.log('');
    console.log('Next:');
    for (const step of payload.next) console.log(`  ${step}`);
  }
}

async function runStatus(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseStatus(args);
  const source = await fetchFeishuSource(engine, opts.sourceId);
  const sourceConfig = parseJsonObject(source?.config);
  const configuredSchemaPack = source
    ? await engine.getConfig(`schema_pack.source.${opts.sourceId}`)
    : null;
  const root = opts.path ?? (source?.local_path ? resolve(source.local_path) : null);
  const mirrorExists = root ? existsSync(root) : false;
  const git = inspectMirrorGit(root);
  const snapshots = collectSnapshotStatus(root);
  const larkVersion = runLocalCommand(['lark-cli', '--version']);
  const larkError = larkVersion.stderr || larkVersion.stdout || `exit ${larkVersion.status}`;

  let schema: { ok: boolean; name: string | null; version: string | null; error?: string };
  try {
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const pack = await loadActivePack({ cfg: null, remote: false, perCall: 'rbrain-feishu' });
    schema = {
      ok: pack.manifest.name === 'rbrain-feishu',
      name: pack.manifest.name,
      version: pack.manifest.version,
    };
  } catch (e) {
    schema = {
      ok: false,
      name: null,
      version: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const hasSnapshots = snapshots.some((snapshot) => snapshot.markdown_files > 0);
  const lastSyncAt = toIsoString(source?.last_sync_at);
  const next: string[] = [];
  if (!source) next.push(`${brand()} feishu setup --path ~/rbrain-feishu`);
  if (!root) next.push(`${brand()} feishu setup --path ~/rbrain-feishu`);
  else if (!mirrorExists || git.state === 'missing') next.push(`${brand()} feishu setup --path "${root}" --force`);
  if (git.state === 'dirty') next.push(`git -C "${root}" status`);
  if (!hasSnapshots && root && mirrorExists) next.push(`${brand()} feishu refresh`);
  if (source && !lastSyncAt) next.push(`${brand()} feishu refresh`);
  if (source && configuredSchemaPack !== 'rbrain-feishu') {
    next.push(`${brand()} feishu setup --path "${root ?? '~/rbrain-feishu'}" --source-id ${opts.sourceId} --force`);
  }
  if (!larkVersion.ok) next.push('lark-cli doctor');
  if (!schema.ok) next.push(`${brand()} schema show rbrain-feishu`);

  const ok =
    Boolean(source) &&
    mirrorExists &&
    git.state === 'clean' &&
    hasSnapshots &&
    Boolean(lastSyncAt) &&
    configuredSchemaPack === 'rbrain-feishu' &&
    larkVersion.ok &&
    schema.ok;
  const payload = {
    status: ok ? 'ok' as const : 'warn' as const,
    source: {
      id: opts.sourceId,
      registered: Boolean(source),
      name: source?.name ?? null,
      local_path: source?.local_path ? resolve(source.local_path) : null,
      federated: sourceConfig.federated === true,
      schema_pack: configuredSchemaPack ?? (typeof sourceConfig.schema_pack === 'string' ? sourceConfig.schema_pack : null),
      last_sync_at: lastSyncAt,
      last_commit: source?.last_commit ?? null,
    },
    mirror: {
      path: root,
      exists: mirrorExists,
      git,
      snapshots,
    },
    lark_cli: {
      ok: larkVersion.ok,
      version: larkVersion.ok ? larkVersion.stdout : null,
      ...(larkVersion.ok ? {} : { error: larkError }),
    },
    schema,
    next: Array.from(new Set(next)),
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printStatusResult(payload);
}

function printAilyPushResult(payload: AilyPushSpaceResult): void {
  console.log(`Aily knowledge space push: ${payload.status}`);
  console.log(`  space: ${payload.knowledge_space_id}`);
  console.log(`  mirror: ${payload.path}`);
  console.log(`  mode: ${payload.dry_run ? 'dry-run' : payload.replace ? 'replace' : 'create-missing'}`);
  console.log(
    `  assets: ${payload.candidates} candidates, ` +
    `${payload.created} created, ${payload.updated} updated, ` +
    `${payload.skipped} skipped, ${payload.failed} failed`,
  );
  for (const asset of payload.assets) {
    const id = asset.knowledge_asset_id ? ` ${asset.knowledge_asset_id}` : '';
    const status = asset.asset_status ? ` (${asset.asset_status})` : '';
    console.log(`  ${asset.action}: ${asset.relative_path} -> ${asset.title}${id}${status}`);
    if (asset.error) console.log(`    ${asset.error}`);
  }
}

async function runAily(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }
  if (sub !== 'push-space') {
    throw new Error(`Usage: ${brand()} feishu aily push-space --space-id <knowledge_space_xxx> [--dry-run]`);
  }

  const rawArgs = args.slice(1);
  const initialOpts = parseAilyPushSpace(rawArgs, loadAilyEnv(rawArgs), { requireKnowledgeSpaceId: false });
  const root = await resolveMirrorRoot(engine, initialOpts);
  const env = loadAilyEnv(rawArgs, root);
  const opts = parseAilyPushSpace(rawArgs, env);
  const token = opts.dryRun
    ? { token: '', source: '(not needed for dry-run)' }
    : resolveAilyApiToken(opts.tokenEnv, env);
  const payload = await pushAilyKnowledgeSpace({
    root,
    host: opts.host,
    knowledgeSpaceId: opts.knowledgeSpaceId,
    token: token.token,
    sourceUrlBase: opts.sourceUrlBase,
    limit: opts.limit,
    replace: opts.replace,
    dryRun: opts.dryRun,
  });

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printAilyPushResult(payload);
    if (!opts.dryRun) {
      console.log(`  token source: ${token.source}`);
    }
  }
  if (payload.failed > 0) process.exitCode = 1;
}

async function runSetup(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseSetup(args);
  const mirror = createMirror(opts);
  if (
    mirror.git.repository === 'skipped' ||
    mirror.git.repository === 'unavailable' ||
    mirror.git.repository === 'failed' ||
    mirror.git.commit === 'failed'
  ) {
    throw new Error(
      `Feishu setup needs a usable local Git mirror because ${brand()} sync is Git-based. ` +
      `Git status: repository=${mirror.git.repository}, commit=${mirror.git.commit}` +
      (mirror.git.error ? ` (${mirror.git.error})` : ''),
    );
  }
  const source = await registerFeishuSource(engine, opts);
  const syncRun = opts.sync
    ? opts.json
      ? await withCapturedStdout(() => syncFeishuSource(engine, { ...opts, full: true }))
      : { result: await syncFeishuSource(engine, { ...opts, full: true }), stdout: '' }
    : null;

  const payload = {
    status: 'ok',
    mirror,
    source,
    sync: syncRun ? syncRun.result : null,
    next: [
      `${opts.path}/scripts/pull-feishu-agenda.sh`,
      `${brand()} sync --source ${opts.sourceId} --no-embed`,
    ],
  };
  const payloadWithLogs = syncRun?.stdout ? { ...payload, sync_stdout: syncRun.stdout } : payload;

  if (opts.json) {
    console.log(JSON.stringify(payloadWithLogs, null, 2));
    return;
  }

  printInitResult(mirror);
  console.log('');
  console.log(`RBrain source "${source.source_id}" ${source.status}: ${source.path}`);
  if (source.default) console.log(`Default source set to "${source.source_id}".`);
  if (opts.sync) console.log('Initial sync completed.');
  else console.log(`Run ${brand()} sync --source ${source.source_id} --no-embed after collecting Feishu snapshots.`);
}

function runCommand(argv: readonly string[]): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  return runLocalCommand(argv);
}

async function runDoctor(args: string[]): Promise<void> {
  const opts = parseDoctor(args);
  const checks = [
    { id: 'lark-cli-path', argv: ['which', 'lark-cli'] },
    { id: 'lark-cli-version', argv: ['lark-cli', '--version'] },
    { id: 'lark-cli-doctor', argv: ['lark-cli', 'doctor'] },
    ...FEISHU_DOCTOR_CAPABILITY_CHECKS,
  ];
  const results = checks.map((check) => ({ ...check, ...runCommand(check.argv) }));
  try {
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const pack = await loadActivePack({ cfg: null, remote: false, perCall: 'rbrain-feishu' });
    results.push({
      id: 'rbrain-schema',
      argv: ['schema:validate', 'rbrain-feishu'],
      ok: pack.manifest.name === 'rbrain-feishu',
      status: 0,
      stdout: `${pack.manifest.name} v${pack.manifest.version}`,
      stderr: '',
    });
  } catch (e) {
    results.push({
      id: 'rbrain-schema',
      argv: ['schema:validate', 'rbrain-feishu'],
      ok: false,
      status: 1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    });
  }
  const ok = results.every((r) => r.ok);

  if (opts.json) {
    console.log(JSON.stringify({ status: ok ? 'ok' : 'fail', checks: results }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const r of results) {
    const mark = r.ok ? 'OK' : 'FAIL';
    const detail = r.stdout || r.stderr || `exit ${r.status}`;
    console.log(`${mark} ${r.id}: ${detail.split('\n')[0]}`);
  }
  if (!ok) {
    console.log('');
    console.log('Run `lark-cli auth` or `lark-cli doctor` to repair Feishu access. If a collector check fails, upgrade lark-cli and retry.');
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`${brand()} feishu — Feishu mirror helpers for RBrain

USAGE
  ${brand()} feishu <command> [options]

COMMANDS
  init [--path DIR] [--force] [--no-git] [--json]
      Create a local Feishu mirror folder and starter collection scripts.

  setup [--path DIR] [--source-id feishu] [--name Feishu] [--force]
        [--no-default] [--sync] [--embed] [--json]
      Create the mirror, register it as an RBrain source, and optionally sync.

  pull <agenda|approval-initiated|approval-tasks|base-fields|base-records|base-search|base-tables|doc|docs-list|drive-search|im-chat-list|im-chat-messages|im-chat-search|im-flags|im-message-search|mail-triage|minutes-search|okr-cycle-detail|okr-cycles|tasks|wiki-nodes|wiki-spaces> [--source-id feishu] [--path DIR]
       [--sync] [--embed] [--json]
      Collect a Feishu snapshot into the mirror and commit it.

  pull docs-list --file <manifest.tsv> [--sync]
      Collect every Feishu doc listed in a local manifest file.

  pull drive-search [--query TEXT] [--doc-types docx,wiki] [--mine]
      Search Feishu Drive/Wiki and save discovery results.

  pull wiki-spaces [--page-all] [--page-limit N]
      List accessible Feishu Wiki spaces.

  pull wiki-nodes [--space-id SPACE] [--parent-node-token TOKEN] [--page-all]
      List Wiki nodes in a space or under a parent node.

  pull mail-triage [--query TEXT] [--filter JSON] [--mailbox me] [--max N]
      Collect Feishu Mail summaries into the mirror.

  pull approval-tasks [--params JSON] [--page-all] [--page-limit N]
      Collect approval tasks assigned to you.

  pull approval-initiated [--params JSON] [--page-all] [--page-limit N]
      Collect approval instances initiated by you.

  pull okr-cycles [--time-range YYYY-MM--YYYY-MM] [--user-id ID]
      List OKR cycles visible to the current or selected user.

  pull okr-cycle-detail --cycle-id ID
      Collect objectives and key results for one OKR cycle.

  pull base-tables --base-token TOKEN
      List tables in a Feishu Base.

  pull base-fields --base-token TOKEN --table-id TABLE
      List fields in a Base table.

  pull base-records --base-token TOKEN --table-id TABLE [--field-id NAME] [--limit N]
      List records in a Base table as JSON.

  pull base-search --base-token TOKEN --table-id TABLE --search-json JSON
      Search records in a Base table.

  pull im-chat-list [--types group,p2p] [--exclude-muted]
      List chats visible to the current Feishu identity.

  pull im-chat-search [--query TEXT] [--member-ids open_id,...]
      Search visible group chats.

  pull im-chat-messages --chat-id CHAT [--start ISO] [--end ISO]
      List messages in a selected chat.

  pull im-message-search [--query TEXT] [--chat-id CHAT] [--is-at-me]
      Search messages across visible chats.

  pull im-flags [--page-all]
      Collect Feishu message bookmarks.

  refresh [--source-id feishu] [--path DIR] [--no-sync] [--embed] [--json]
          [--no-agenda] [--no-tasks] [--task-query TEXT] [--tasks-all]
          [--minutes-query TEXT] [--drive-query TEXT] [--mail-query TEXT]
          [--approval-tasks] [--approval-initiated] [--okr-cycles] [--okr-cycle-id ID]
          [--base-token TOKEN] [--base-tables] [--base-records] [--base-table-id TABLE]
          [--im-query TEXT] [--im-chat-id CHAT] [--im-flags]
          [--wiki-spaces] [--wiki-space-id SPACE] [--wiki-parent-node-token TOKEN]
          [--start DATE] [--end DATE]
      Daily refresh: collect agenda + incomplete tasks, optional search/wiki/mail/OKR/approval/Base/IM, then sync once.

  status [--source-id feishu] [--path DIR] [--json]
      Show Feishu mirror/source readiness, snapshots, Git state, and schema health.

  doctor [--json]
      Check lark-cli, Feishu auth health, and the rbrain-feishu schema pack.

  aily push-space [--space-id knowledge_space_xxx] [--path DIR] [--env-file FILE] [--dry-run]
      Upload Feishu mirror markdown snapshots to an Aily knowledge space.
      Uses ${AILY_DEFAULT_TOKEN_ENV} (or ${AILY_FALLBACK_TOKEN_ENV}) for x-api-token.
      Reads .env from the current directory, the mirror root, or --env-file.
      Existing API-created assets are skipped unless --replace is passed.

  managed sync [--path DIR] [--registry FILE] [--registry-store json|postgres]
               [--registry-url POSTGRES_URL] [--registry-ensure-schema]
               [--space-id knowledge_space_xxx] [--dry-run]
               [--base-token TOKEN --base-table-id TABLE]
      Prototype a Feishu-native managed asset registry using the default local JSON store.
      Creates/updates sources, assets, and sync_runs rows, then previews Base rows.
      Hash-matching assets are skipped locally; changed assets update Aily by title.
      Set ${MANAGED_REGISTRY_DATABASE_URL_ENV} or --registry-url to use the Postgres store.
      When Base args are present, mirrors rows by Source URI via lark-cli record search/upsert.

  managed status [--path DIR] [--registry-store json|postgres] [--registry-url POSTGRES_URL]
                 [--registry-ensure-schema] [--json]
      Inspect managed registry counts, latest sync run, Aily statuses, and Base preview rows.

  managed refresh-status [--path DIR] [--registry-store json|postgres] [--registry-url POSTGRES_URL]
                         [--space-id knowledge_space_xxx] [--dry-run]
                         [--base-token TOKEN --base-table-id TABLE] [--json]
      Re-read Aily knowledge asset statuses and update registry/Base status rows.

  managed wait-status [--path DIR] [--registry-store json|postgres] [--registry-url POSTGRES_URL]
                      [--space-id knowledge_space_xxx] [--target-status successful]
                      [--timeout-ms 300000] [--interval-ms 15000] [--json]
      Poll Aily status refresh until managed assets reach the target status.

  managed base-template [--json]
      Print the Feishu Base field template used by managed sync status mirroring.

  managed trigger-template [--json] [--import SPECIFIER] [--source-input mirror|inline]
      Print a TypeScript HTTP/scheduled trigger wrapper for managed sync/status.

  managed deploy-bundle [--out DIR] [--import SPECIFIER] [--dependency SPEC]
                        [--source-input mirror|inline] [--force] [--json]
      Write trigger, local server, package.json, Postgres DDL, env example, and README files for deployment.

  managed deploy-plan [--url URL] [--env-file FILE] [--source-input mirror|inline]
                      [--target-status successful] [--json]
      Print an ordered, secret-safe deployment and verification plan.

  managed env-check [--target status|canary|sync] [--source-input mirror|inline] [--env-file FILE] [--json]
      Check managed runtime env names without printing secret values.

  managed probe [--action capabilities|status|sync|refresh-status] [--root DIR] [--asset-json JSON] [--url URL] [--json]
      Print or POST a managed trigger capabilities/status/sync/refresh-status probe.
      Sync and refresh-status probes default to dry-run.

  managed canary --url URL [--root DIR] [--asset-json JSON] [--status-only] [--wait-status] [--json]
      POST status, sync, refresh-status, and optionally wait for target status.

  managed sql-schema [--json]
      Print the Postgres DDL for the managed sources/assets/sync_runs registry.

  managed provision-registry --registry-url POSTGRES_URL [--json]
      Apply the managed Postgres DDL and report registry counts.

  managed provision-base --base-token TOKEN [--table-name NAME] [--dry-run] [--json]
      Create the managed asset status table in an existing Feishu Base.

EXAMPLES
  ${brand()} feishu init
  ${brand()} feishu setup --path ~/rbrain-feishu
  ${brand()} feishu setup --path ~/rbrain-feishu --sync
  ${brand()} feishu refresh
  ${brand()} feishu status
  ${brand()} feishu refresh --minutes-query "项目复盘" --start 2026-06-01 --end 2026-06-07
  ${brand()} feishu refresh --drive-query "roadmap" --wiki-spaces --mail-query "budget"
  ${brand()} feishu refresh --approval-tasks --okr-cycles
  ${brand()} feishu refresh --base-token appxxx --base-tables --base-records --base-table-id tblxxx
  ${brand()} feishu refresh --im-query "pricing" --im-flags
  ${brand()} feishu pull agenda --sync
  ${brand()} feishu pull tasks --incomplete --sync
  ${brand()} feishu pull doc "https://example.feishu.cn/docx/..." product-review --sync
  ${brand()} feishu pull docs-list --file ~/rbrain-feishu/feishu/docs/docs-list.tsv --sync
  ${brand()} feishu pull drive-search --query "roadmap" --doc-types docx,wiki --sync
  ${brand()} feishu pull wiki-spaces --page-all --sync
  ${brand()} feishu pull wiki-nodes --space-id my_library --sync
  ${brand()} feishu pull mail-triage --query "budget" --max 50 --sync
  ${brand()} feishu pull approval-tasks --page-all --sync
  ${brand()} feishu pull okr-cycles --time-range 2026-01--2026-06 --sync
  ${brand()} feishu pull okr-cycle-detail --cycle-id 123456 --sync
  ${brand()} feishu pull base-tables --base-token appxxx --sync
  ${brand()} feishu pull base-records --base-token appxxx --table-id tblxxx --field-id Name --sync
  ${brand()} feishu pull im-chat-list --types group,p2p --sync
  ${brand()} feishu pull im-message-search --query "pricing" --sync
  ${brand()} feishu pull im-chat-messages --chat-id oc_xxx --sync
  ${brand()} feishu aily push-space --space-id knowledge_space_xxx --dry-run
  ${brand()} feishu managed base-template --json
  ${brand()} feishu managed trigger-template > feishu-managed-trigger.ts
  ${brand()} feishu managed trigger-template --source-input inline > feishu-managed-trigger.ts
  ${brand()} feishu managed deploy-bundle --out ./feishu-managed-deploy --dependency github:Lostein/gbrain --json
  ${brand()} feishu managed deploy-bundle --source-input inline --out ./feishu-managed-deploy --dependency github:Lostein/gbrain --json
  ${brand()} feishu managed deploy-plan --url https://example.com/trigger --json
  ${brand()} feishu managed deploy-plan --source-input inline --url https://example.com/trigger --json
  ${brand()} feishu managed env-check --target canary --env-file ./feishu-managed-deploy/.env.example --json
  ${brand()} feishu managed env-check --target canary --source-input inline --json
  ${brand()} feishu managed probe --action capabilities --json
  ${brand()} feishu managed probe --action status --json
  ${brand()} feishu managed probe --action sync --root ~/rbrain-feishu --url https://example.com/trigger --json
  ${brand()} feishu managed probe --action sync --asset-json '{"sourceUri":"https://feishu.example/doc/smoke","content":"# Smoke\\n\\nInline sample text."}' --url https://example.com/trigger --json
  ${brand()} feishu managed probe --action refresh-status --url https://example.com/trigger --json
  ${brand()} feishu managed canary --root ~/rbrain-feishu --url https://example.com/trigger --json
  ${brand()} feishu managed canary --asset-json '{"sourceUri":"https://feishu.example/doc/smoke","content":"# Smoke\\n\\nInline sample text."}' --url https://example.com/trigger --json
  ${brand()} feishu managed canary --root ~/rbrain-feishu --url https://example.com/trigger --no-dry-run --wait-status --json
  ${brand()} feishu managed sql-schema > feishu-managed-registry.sql
  ${brand()} feishu managed provision-registry --registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}" --json
  ${brand()} feishu managed provision-base --base-token appxxx --table-name "RBrain Managed Assets" --dry-run --json
  ${brand()} feishu managed sync --path ~/rbrain-feishu --space-id knowledge_space_xxx --dry-run --json
  ${brand()} feishu managed refresh-status --path ~/rbrain-feishu --space-id knowledge_space_xxx --json
  ${brand()} feishu managed wait-status --path ~/rbrain-feishu --space-id knowledge_space_xxx --timeout-ms 300000 --json
  ${brand()} feishu managed status --path ~/rbrain-feishu --json
  ${brand()} feishu managed sync --path ~/rbrain-feishu --registry-store postgres --registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}" --registry-ensure-schema --space-id knowledge_space_xxx
  ${brand()} feishu managed refresh-status --registry-store postgres --registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}" --space-id knowledge_space_xxx --json
  ${brand()} feishu managed wait-status --registry-store postgres --registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}" --space-id knowledge_space_xxx --json
  ${brand()} feishu managed status --registry-store postgres --registry-url "$${MANAGED_REGISTRY_DATABASE_URL_ENV}" --json
  ${AILY_DEFAULT_TOKEN_ENV}=... ${brand()} feishu aily push-space --space-id knowledge_space_xxx
  ${brand()} feishu doctor
`);
}

export async function runFeishu(args: string[], ctx: FeishuContext = {}): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }
  if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
    printHelp();
    return;
  }
  if (sub === 'init') {
    await runInit(args.slice(1));
    return;
  }
  if (sub === 'setup') {
    if (!ctx.engine) {
      throw new Error(`${brand()} feishu setup requires an initialized local RBrain database. Run ${brand()} init first.`);
    }
    await runSetup(ctx.engine, args.slice(1));
    return;
  }
  if (sub === 'pull') {
    if (!ctx.engine) {
      throw new Error(`${brand()} feishu pull requires an initialized local RBrain database. Run ${brand()} init first.`);
    }
    await runPull(ctx.engine, args.slice(1));
    return;
  }
  if (sub === 'refresh') {
    if (!ctx.engine) {
      throw new Error(`${brand()} feishu refresh requires an initialized local RBrain database. Run ${brand()} init first.`);
    }
    await runRefresh(ctx.engine, args.slice(1));
    return;
  }
  if (sub === 'status') {
    if (!ctx.engine) {
      throw new Error(`${brand()} feishu status requires an initialized local RBrain database. Run ${brand()} init first.`);
    }
    await runStatus(ctx.engine, args.slice(1));
    return;
  }
  if (sub === 'aily') {
    if (!ctx.engine) {
      throw new Error(`${brand()} feishu aily requires an initialized local RBrain database. Run ${brand()} init first.`);
    }
    await runAily(ctx.engine, args.slice(1));
    return;
  }
  if (sub === 'managed') {
    await runManaged(ctx.engine, args.slice(1));
    return;
  }
  if (sub === 'doctor') {
    await runDoctor(args.slice(1));
    return;
  }
  console.error(`Unknown feishu command: ${sub}`);
  printHelp();
  process.exit(2);
}
