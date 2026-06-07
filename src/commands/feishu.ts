import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { BrainEngine } from '../core/engine.ts';
import { assertValidSourceId } from '../core/source-id.ts';
import { addSource as addBrainSource, SourceOpError } from '../core/sources-ops.ts';
import {
  MANAGED_BASE_FIELD_NAMES,
  FEISHU_MANAGED_SQL_SCHEMA_VERSION,
  buildManagedBaseRecordFields,
  buildManagedBaseTableFieldsJson,
  buildManagedBaseMirrorRows,
  buildManagedRegistrySqlSchema,
  cloneManagedRegistry,
  defaultManagedRegistryPath,
  loadManagedRegistry,
  recordManagedSyncResult,
  saveManagedRegistry,
  type ManagedAssetObservation,
  type ManagedBaseMirrorRow,
  type ManagedRegistrySnapshot,
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

interface AilyPushSpaceOpts {
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

interface ManagedSyncOpts extends AilyPushSpaceOpts {
  registryPath?: string;
  trigger: string;
  sourceKind: ManagedSourceKind;
  sourceName: string;
  baseToken?: string;
  baseTableId?: string;
  baseAs?: string;
}

interface ManagedBaseProvisionOpts {
  baseToken?: string;
  tableName: string;
  as?: string;
  dryRun: boolean;
  json: boolean;
}

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
type EnvLookup = Record<string, string | undefined>;

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

function parseManagedSync(
  args: string[],
  env: EnvLookup = process.env,
  opts: { requireKnowledgeSpaceId?: boolean } = {},
): ManagedSyncOpts {
  const aily = parseAilyPushSpace(args, env, opts);
  return {
    ...aily,
    registryPath: parseFlagValue(args, '--registry') ? expandPath(parseFlagValue(args, '--registry')!) : undefined,
    trigger: parseFlagValue(args, '--trigger') ?? 'manual',
    sourceKind: parseManagedSourceKind(parseFlagValue(args, '--source-kind')),
    sourceName: parseFlagValue(args, '--name') ?? 'Feishu',
    baseToken: parseFlagValue(args, '--base-token'),
    baseTableId: parseFlagValue(args, '--base-table-id'),
    baseAs: parseFlagValue(args, '--base-as'),
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

function readAilyCandidateContent(candidate: AilyPushCandidate): string {
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
  if (sub === 'provision-base') {
    const payload = provisionManagedBaseTable(parseManagedBaseProvision(args.slice(1)));
    if (args.includes('--json')) console.log(JSON.stringify(payload, null, 2));
    else printManagedBaseProvisionResult(payload);
    if (payload.status === 'failed') process.exitCode = 1;
    return;
  }
  if (sub !== 'sync') {
    throw new Error(`Usage: ${brand()} feishu managed <sync|base-template|provision-base> [options]`);
  }

  const rawArgs = args.slice(1);
  const initialOpts = parseManagedSync(rawArgs, loadAilyEnv(rawArgs), { requireKnowledgeSpaceId: false });
  if (!initialOpts.path && !engine) {
    throw new Error(`${brand()} feishu managed sync needs --path DIR when no local RBrain database is connected.`);
  }
  const root = initialOpts.path ? initialOpts.path : await resolveMirrorRoot(engine!, initialOpts);
  const env = loadAilyEnv(rawArgs, root);
  const opts = parseManagedSync(rawArgs, env);
  const registryPath = opts.registryPath ?? defaultManagedRegistryPath(root);
  const registry = loadManagedRegistry(registryPath);
  const candidates = collectAilyPushCandidates(root, {
    limit: opts.limit,
    sourceUrlBase: opts.sourceUrlBase,
  });
  const previousByTitle = new Map(registry.assets.map((asset) => [asset.aily_asset_title, asset]));
  const unchanged = new Map<string, AilyPushItemResult>();
  const pushCandidates: AilyPushCandidate[] = [];
  const knownExisting = registryAilyAssets(registry);
  const startedAt = new Date().toISOString();

  for (const candidate of candidates) {
    const previous = previousByTitle.get(candidate.title);
    const sameHash = previous?.content_sha256 === candidate.content_sha256;
    if (sameHash && previous?.aily_asset_id && !opts.replace) {
      unchanged.set(candidate.relative_path, {
        ...candidate,
        action: opts.dryRun ? 'dry_run_skip_existing' : 'skipped_existing',
        knowledge_asset_id: previous.aily_asset_id,
        asset_status: previous.aily_status ?? undefined,
      });
    } else {
      pushCandidates.push(candidate);
    }
  }

  const token = opts.dryRun || pushCandidates.length === 0
    ? { token: '', source: '(not needed)' }
    : resolveAilyApiToken(opts.tokenEnv, env);
  const pushed = pushCandidates.length === 0
    ? summarizeAilyPushAssets({
        root,
        host: opts.host,
        knowledgeSpaceId: opts.knowledgeSpaceId,
        dryRun: opts.dryRun,
        replace: opts.replace,
        assets: [],
      })
    : await pushAilyKnowledgeSpace({
        root,
        host: opts.host,
        knowledgeSpaceId: opts.knowledgeSpaceId,
        token: token.token,
        sourceUrlBase: opts.sourceUrlBase,
        replace: true,
        dryRun: opts.dryRun,
        candidates: pushCandidates,
        dryRunExistingAssets: Array.from(knownExisting.values()),
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
    root,
    host: opts.host,
    knowledgeSpaceId: opts.knowledgeSpaceId,
    dryRun: opts.dryRun,
    replace: opts.replace,
    assets,
  });

  const finishedAt = new Date().toISOString();
  const record = recordManagedSyncResult(opts.dryRun ? cloneManagedRegistry(registry) : registry, {
    source: {
      id: opts.sourceId,
      kind: opts.sourceKind,
      name: opts.sourceName,
      config_json: {
        mirror_path: root,
        registry_path: registryPath,
        aily_host: opts.host,
        aily_knowledge_space_id: opts.knowledgeSpaceId,
        source_url_base: opts.sourceUrlBase,
      },
    },
    trigger: opts.trigger,
    started_at: startedAt,
    finished_at: finishedAt,
    assets: assets.map(managedObservationFromAilyAsset),
  });
  if (!opts.dryRun) saveManagedRegistry(registryPath, record.snapshot);
  const baseRows = buildManagedBaseMirrorRows(record.snapshot);
  const baseWrite = mirrorManagedBaseRows({
    rows: baseRows,
    baseToken: opts.baseToken,
    tableId: opts.baseTableId,
    as: opts.baseAs,
    dryRun: opts.dryRun,
  });
  const payload = buildManagedSyncPayload({
    registryPath,
    persisted: !opts.dryRun,
    syncRun: record.sync_run,
    push: combinedPush,
    baseRows,
    baseWrite,
  });

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printManagedSyncResult(payload);
    if (!opts.dryRun && pushCandidates.length > 0) console.log(`  token source: ${token.source}`);
  }
  if (combinedPush.failed > 0 || baseWrite.failed > 0) process.exitCode = 1;
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

  managed sync [--path DIR] [--registry FILE] [--space-id knowledge_space_xxx] [--dry-run]
               [--base-token TOKEN --base-table-id TABLE]
      Prototype a Feishu-native managed asset registry using local JSON state.
      Creates/updates sources, assets, and sync_runs rows, then previews Base rows.
      Hash-matching assets are skipped locally; changed assets update Aily by title.
      When Base args are present, mirrors rows by Source URI via lark-cli record search/upsert.

  managed base-template [--json]
      Print the Feishu Base field template used by managed sync status mirroring.

  managed sql-schema [--json]
      Print the Postgres DDL for the managed sources/assets/sync_runs registry.

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
  ${brand()} feishu managed sql-schema > feishu-managed-registry.sql
  ${brand()} feishu managed provision-base --base-token appxxx --table-name "RBrain Managed Assets" --dry-run --json
  ${brand()} feishu managed sync --path ~/rbrain-feishu --space-id knowledge_space_xxx --dry-run --json
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
