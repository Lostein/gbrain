# RBrain Feishu Native Architecture Proposal

本文档用于推进 `rbrain-feishu` 的下一阶段工作：从“本地 RBrain
工作区 + 本地数据库”的开发者工具，演进为更符合飞书企业场景的
Feishu Native 知识运营系统。

当前建议不是把 RBrain 原样搬到飞书里，而是把 RBrain 拆成四个更清晰的
职责面：

- Aily Knowledge Space: 线上问答主知识库，负责 embedding、检索和智能体回答。
- Miaoda / Feishu aPaaS: 线上处理层，负责同步任务、缓存、评测、图谱和 OpenAPI。
- Feishu Base: 人工可见的运营台账、评测面板、图谱审核和治理工作流。
- Local RBrain CLI: 开发者模式，负责本地调试、离线导入、兼容现有 GBrain 能力。

## Executive Decision

推荐的目标架构是：

```text
Feishu Docs / Wiki / Drive / IM / Base
        |
        v
Miaoda scheduled jobs and server functions
        |
        +--> Serverless PostgreSQL
        |       - sync state
        |       - asset cache
        |       - eval cases and runs
        |       - entity/relation/fact graph
        |       - audit logs
        |
        +--> Aily Knowledge Space
        |       - uploaded knowledge assets
        |       - embedding and retrieval
        |       - runtime knowledge backend for Aily agents
        |
        +--> Feishu Base
        |       - human review tables
        |       - dashboards
        |       - workflow and governance
        |
        v
Aily custom agent in Feishu chat
```

This makes Feishu the user-facing system of record, Aily the runtime retrieval
backend, and Miaoda the online control plane. The local RBrain database remains
valuable, but it becomes optional instead of mandatory for ordinary users.

## Why Change

The current `rbrain-feishu` path works, but it is still developer-shaped:

- Users need a local mirror directory such as `~/rbrain-feishu`.
- Users need local RBrain state under `~/.rbrain`.
- Full RBrain retrieval and graph features expect PGLite, Postgres, or Supabase.
- Aily ingestion currently starts from local Markdown snapshots.

That is fine for Codex, developers, and power users. It is not ideal for a
Feishu-native product because most enterprise users expect:

- No local CLI setup.
- No local database.
- Feishu permissions and audit surfaces.
- A web UI or Feishu app entrypoint.
- Scheduled background sync.
- Human-readable dashboards and review tables.

## Product Boundary

The clean product boundary should be:

| Layer | Primary responsibility | Should own |
|---|---|---|
| Feishu Docs/Wiki/Drive/IM | Source content and permissions | Original documents, collaboration, access control |
| Aily Knowledge Space | Runtime knowledge retrieval | Text assets, embeddings, retrieval, agent knowledge |
| Miaoda Serverless PG | Control plane state | Sync runs, asset status, eval results, graph cache, audits |
| Feishu Base | Human governance UI | Review queues, dashboards, manual corrections |
| Local RBrain | Developer and migration tool | Offline import, local debugging, advanced graph/eval experiments |

Do not make one layer carry every responsibility. In particular:

- Do not use Base as a high-performance vector database.
- Do not use Aily Knowledge Space as the full graph/eval database.
- Do not require local RBrain DB for the default Feishu user journey.
- Do not hide human governance state inside a local-only database.

## Architecture Modes

### Mode 1: Local Developer Mode

This is the current reliable path.

```text
lark-cli -> local Markdown mirror -> local RBrain DB -> optional Aily push
```

Use it for:

- development
- debugging
- schema-pack iteration
- offline evaluation
- backwards compatibility with GBrain features

### Mode 2: Feishu Native Managed Mode

This is the recommended product direction.

```text
Miaoda jobs -> Serverless PG + Base -> Aily Knowledge Space -> Aily agent
```

Use it for:

- normal enterprise users
- scheduled sync
- production knowledge operations
- shared dashboards
- team-level governance

### Mode 3: Hybrid Mode

This bridges the two.

```text
local RBrain CLI <-> Miaoda OpenAPI <-> Serverless PG / Base / Aily
```

Use it for:

- migration from local mirrors to managed deployments
- power-user debugging
- replaying production failures locally
- bulk import from developer machines

## Minimal Data Model

The first Feishu Native implementation does not need to port every GBrain table.
Start with the state required to manage knowledge assets, evaluation, and graph
review.

### Serverless PG Tables

#### `sources`

Tracks source systems and collection scopes.

| Column | Purpose |
|---|---|
| `id` | Stable source id, for example `feishu` |
| `kind` | `drive`, `wiki`, `doc`, `im`, `base`, `manual` |
| `name` | Human-readable source name |
| `config_json` | Scope, folder tokens, space ids, filters |
| `enabled` | Whether scheduled sync should include this source |
| `created_at` / `updated_at` | Audit timestamps |

#### `assets`

Tracks documents or generated knowledge assets.

| Column | Purpose |
|---|---|
| `id` | Internal id |
| `source_id` | Owning source |
| `source_uri` | Feishu URL, token, or synthetic URI |
| `title` | Display title |
| `content_sha256` | Deduplication and change detection |
| `normalized_text_uri` | Optional pointer to cached normalized text |
| `aily_asset_id` | Knowledge Space asset id |
| `aily_asset_title` | Deterministic uploaded title |
| `aily_status` | `learning`, `successful`, `failed`, etc. |
| `last_synced_at` | Last successful sync timestamp |

#### `sync_runs`

Tracks each scheduled or manual sync.

| Column | Purpose |
|---|---|
| `id` | Run id |
| `trigger` | `manual`, `schedule`, `webhook`, `api` |
| `source_id` | Optional scoped source |
| `status` | `running`, `success`, `partial`, `failed` |
| `started_at` / `finished_at` | Duration and ordering |
| `assets_seen` / `assets_changed` / `assets_uploaded` | Rollup metrics |
| `error_summary` | Short human-readable error |
| `log_uri` | Pointer to detailed logs |

#### `eval_cases`

Stores stable test questions.

| Column | Purpose |
|---|---|
| `id` | Case id |
| `query` | User question |
| `expected_behavior` | What a good answer should do |
| `expected_assets_json` | Optional expected asset ids or titles |
| `tags` | `sync`, `permission`, `graph`, `regression`, etc. |
| `enabled` | Whether nightly eval includes it |

#### `eval_runs`

Stores evaluation batches.

| Column | Purpose |
|---|---|
| `id` | Run id |
| `trigger` | `manual`, `nightly`, `pre-release` |
| `agent_id` | Aily agent or test surface |
| `knowledge_space_id` | Target knowledge space |
| `status` | Run status |
| `started_at` / `finished_at` | Duration |
| `summary_json` | Scores and rollups |

#### `eval_results`

Stores one result per eval case per run.

| Column | Purpose |
|---|---|
| `run_id` | Parent eval run |
| `case_id` | Eval case |
| `actual_answer` | Captured answer |
| `score` | Numeric or rubric score |
| `failure_type` | `no_answer`, `wrong_source`, `stale`, `hallucination`, etc. |
| `retrieved_assets_json` | Assets or citations observed |
| `judge_notes` | Human or model judge notes |

#### `entities`

Stores extracted entities for graph review.

| Column | Purpose |
|---|---|
| `id` | Entity id |
| `name` | Canonical name |
| `type` | `person`, `team`, `project`, `doc`, `system`, etc. |
| `aliases_json` | Alternative names |
| `confidence` | Extraction confidence |
| `review_status` | `pending`, `approved`, `rejected` |

#### `relations`

Stores graph edges.

| Column | Purpose |
|---|---|
| `id` | Relation id |
| `from_entity_id` / `to_entity_id` | Edge endpoints |
| `type` | `owns`, `mentions`, `depends_on`, `decided_by`, etc. |
| `source_asset_id` | Provenance asset |
| `evidence_text` | Short evidence excerpt |
| `confidence` | Extraction confidence |
| `review_status` | Human review state |

#### `facts`

Stores structured claims.

| Column | Purpose |
|---|---|
| `id` | Fact id |
| `entity_id` | Subject |
| `fact_type` | `status`, `metric`, `decision`, `risk`, `event` |
| `value_json` | Structured value |
| `event_time` | Optional time dimension |
| `source_asset_id` | Provenance |
| `review_status` | Human review state |

### Feishu Base Tables

Base should mirror a subset of PG for human operations. It does not need every
raw field.

Recommended tables:

- Knowledge Assets
- Sync Runs
- Eval Cases
- Eval Results
- Entities
- Relations
- Facts
- Review Queue

The Base version should optimize for readability and workflow, not storage
normalization. For example, `Relations` can include readable entity names even
if PG stores only ids.

## Runtime Flows

### Sync Flow

```text
1. Miaoda scheduled task starts a sync run.
2. It reads enabled sources from PG.
3. It calls Feishu OpenAPI to discover changed docs, wiki nodes, drive files, or IM records.
4. It normalizes changed items into text assets.
5. It computes content hashes and skips unchanged assets.
6. It uploads changed assets to Aily Knowledge Space.
7. It records Aily asset ids and statuses in PG.
8. It writes rollup rows to Base for visibility.
```

### Eval Flow

```text
1. A manual or nightly trigger creates an eval run.
2. It loads enabled eval cases from PG.
3. It asks the Aily agent or runtime ask surface.
4. It records answer, status, retrieved/cited assets if available.
5. It runs a simple judge or asks a human to review failures in Base.
6. It writes score rollups to PG and Base dashboards.
```

### Graph Review Flow

```text
1. After sync, changed assets enter a lightweight extraction job.
2. The job proposes entities, relations, and facts.
3. Low-confidence items go to a Base review queue.
4. Approved graph rows remain in PG as the operational graph cache.
5. Aily receives concise generated graph summaries as knowledge assets when useful.
```

## What Not To Build First

Avoid porting all of GBrain in the first Feishu Native phase.

Do not start with:

- full local `pages/chunks/embeddings` parity
- custom vector retrieval
- complex graph algorithms
- full MCP server compatibility
- multi-brain federation
- automatic writeback into source Feishu docs

Those are useful later. The first product milestone should prove:

- scheduled collection works online
- Aily Knowledge Space remains the runtime answer backend
- Base gives useful human visibility
- evals catch regressions
- local setup is optional

## MVP Plan

### Phase 0: Keep the local path stable

Already mostly done:

- local `rbrain feishu setup`
- local `rbrain feishu refresh`
- local `rbrain feishu aily push-space`
- concise Aily overview asset for stable retrieval

Exit criteria:

- Aily custom agent answers basic `rbrain-feishu` questions reliably.
- Existing local tests pass.
- Secrets remain in `.env` or tenant config, not in Git.

### Phase 1: Managed asset registry

Build the online control plane skeleton.

Deliverables:

- Miaoda app with Serverless PG.
- `sources`, `assets`, and `sync_runs` tables.
- Manual trigger endpoint: `POST /sync`.
- Knowledge Space upload from Miaoda server function.
- Base mirror for Knowledge Assets and Sync Runs.

Exit criteria:

- A user can trigger sync without local CLI.
- Asset status is visible in Base.
- Aily Knowledge Space gets created or updated assets.

### Phase 2: Eval registry

Add quality control.

Deliverables:

- `eval_cases`, `eval_runs`, and `eval_results` tables.
- Base views for failed cases and regressions.
- Manual eval trigger.
- Nightly scheduled eval.

Exit criteria:

- A small fixed eval suite runs against the Aily agent.
- Failures show up in Base with enough context to debug.
- A bad knowledge push can be detected before users report it.

### Phase 3: Graph and fact review

Add structured memory without making it the runtime retrieval backend.

Deliverables:

- `entities`, `relations`, and `facts` tables.
- Extraction job for changed assets.
- Base review queue for low-confidence graph items.
- Optional generated graph-summary assets pushed to Aily.

Exit criteria:

- Humans can approve/reject extracted graph facts.
- Approved graph state can explain important relationships.
- Aily can answer selected graph-style questions from generated summaries.

### Phase 4: Local/hybrid bridge

Keep developer power without forcing it on all users.

Deliverables:

- CLI command to push local mirror data into the managed Miaoda API.
- CLI command to pull managed sync/eval state for local debugging.
- Compatibility mode for local PGLite/Postgres advanced features.

Exit criteria:

- Developers can reproduce production sync/eval failures locally.
- Ordinary users still never need a local RBrain database.

## Open Questions

Before implementation, confirm these platform details:

1. Does the target Miaoda runtime expose Serverless PostgreSQL features needed
   for our tables and indexes?
2. Does it support `pgvector`? If not, that is acceptable for MVP because Aily
   owns vector retrieval.
3. Can Miaoda server functions call Aily Knowledge Space API with tenant-held
   secrets?
4. Can scheduled tasks run with enough frequency and execution time for sync?
5. What is the best production ask surface for evals: Aily agent API, custom
   agent SDK, Feishu chat webhook, or another runtime endpoint?
6. Can we observe retrieved assets or citations from Aily runs? If not, evals
   should start with answer-level judging.
7. Should Base be generated by Miaoda, plain Feishu Base OpenAPI, or both?

## Platform Assumptions To Verify

This proposal assumes the target tenant has access to the following Feishu
platform capabilities:

- Miaoda / Feishu aPaaS can host an application with data storage, server-side
  logic, scheduled automation, logs, and Serverless PostgreSQL access.
  Reference: [Feishu Miaoda overview](https://www.feishu.cn/content/article/7592171136612306139).
- Feishu low-code platform can expose OpenAPI credentials for external systems
  to call record CRUD, cloud functions, workflows, page links, and attachment
  APIs. Reference: [Feishu low-code OpenAPI](https://www.feishu.cn/content/785259988660).
- Feishu Base can serve as a business-facing table, view, dashboard, workflow,
  and permission surface, with OpenAPI access to apps, tables, records, fields,
  views, dashboards, and advanced permissions. Reference:
  [Feishu Base OpenAPI overview](https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview?lang=zh-CN).

These references are enough to justify a prototype. Before production, verify
tenant-specific quotas, execution time limits, secret management, network
egress, and whether the actual Serverless PostgreSQL instance supports any
extensions we might want later.

## Implementation Notes

The current local implementation should inform the online version:

- Keep deterministic asset titles so updates can be idempotent.
- Keep content hashes so unchanged assets are skipped.
- Keep the concise overview asset because it improved Aily retrieval stability.
- Keep `.env` and tenant-secret separation; never store API tokens in source
  docs or public repo files.
- Preserve the boundary that Knowledge Space API is an ingestion path, not the
  user-facing question-answer API.

## Recommended Next PRs

1. Add this architecture doc and link it from `docs/rbrain/feishu.md`.
2. Use [`feishu-native-phase1.md`](./feishu-native-phase1.md) as the Phase 1
   managed asset registry checklist.
3. Add a `rbrain feishu managed push` design stub for local-to-Miaoda bridge.
4. Prototype the Miaoda schema and sync endpoint outside the core CLI.
5. Backport useful discoveries into `rbrain feishu aily push-space`.

## Decision Summary

Use Aily Knowledge Space as the default runtime knowledge backend. Use Miaoda
Serverless PG as the online control plane. Use Feishu Base as the human
governance and dashboard surface. Keep local RBrain as an advanced developer
mode, not the required default.
