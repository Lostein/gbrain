# Feishu Native Phase 1: Managed Asset Registry

This checklist turns the Feishu Native architecture proposal into the next
implementation slice. It is intentionally smaller than a full managed RBrain
port: Phase 1 only proves that a Feishu-native control plane can manage Aily
knowledge assets without requiring every user to run a local RBrain database.

Related design: [`feishu-native-architecture.md`](./feishu-native-architecture.md).

## Goal

Build a managed asset registry prototype for `rbrain-feishu`.

The prototype should prove this flow:

```text
Feishu source item
        |
        v
managed sync worker
        |
        +--> managed asset registry
        +--> Aily Knowledge Space
        +--> human-readable Base status table
```

## Non-Goals

Do not attempt to port all of GBrain/RBrain in Phase 1.

Out of scope:

- custom vector retrieval
- full local `pages/chunks/embeddings` parity
- graph algorithms
- eval scoring
- MCP server compatibility
- automatic writeback into source Feishu docs

## Required Managed Tables

### `sources`

Represents a Feishu collection scope.

Minimum fields:

- `id`
- `kind`
- `name`
- `config_json`
- `enabled`
- `created_at`
- `updated_at`

Example source kinds:

- `doc`
- `drive`
- `wiki`
- `im`
- `base`
- `manual`

### `assets`

Represents one normalized knowledge asset and its Aily upload state.

Minimum fields:

- `id`
- `source_id`
- `source_uri`
- `title`
- `content_sha256`
- `normalized_text_uri`
- `aily_asset_id`
- `aily_asset_title`
- `aily_status`
- `last_synced_at`
- `created_at`
- `updated_at`

### `sync_runs`

Represents one manual, scheduled, webhook, or API-triggered sync attempt.

Minimum fields:

- `id`
- `trigger`
- `source_id`
- `status`
- `started_at`
- `finished_at`
- `assets_seen`
- `assets_changed`
- `assets_uploaded`
- `error_summary`
- `log_uri`

## Minimum Runtime Flow

1. Create a sync run row with status `running`.
2. Load one enabled source.
3. Discover or accept one Feishu source item.
4. Normalize the item into UTF-8 text suitable for Aily Knowledge Space.
5. Compute `content_sha256`.
6. If the hash matches the existing asset row, skip upload.
7. Otherwise upload or update the Aily knowledge asset.
8. Persist `aily_asset_id`, `aily_asset_title`, `aily_status`, and timestamps.
9. Update the sync run status and counters.
10. Mirror a readable row to Feishu Base if the Base table exists.

## Idempotency Rules

Phase 1 should preserve the useful behavior from `rbrain feishu aily push-space`:

- Deterministic asset titles are derived from source identity.
- Content hashes decide whether an upload is needed.
- Hash-matching registry assets are skipped locally.
- Changed assets update the deterministic Aily asset title in place.
- Secrets never appear in returned JSON, sync logs, Base rows, or committed files.

## Prototype Options

### Option A: Miaoda-first prototype

Build directly inside Miaoda / Feishu aPaaS.

Use when:

- Serverless PostgreSQL and server functions are available in the tenant.
- The runtime can call Aily Knowledge Space API with tenant-held secrets.
- The team wants to validate product experience first.

Risk:

- Local automated tests will be thinner until the platform surface is wrapped.

### Option B: Local adapter first

Add a local adapter command that models the managed API:

```bash
rbrain feishu managed sync --source-id feishu
rbrain feishu managed push-asset --file path/to/asset.md
```

Use when:

- Miaoda platform details are still unclear.
- We want unit-testable interfaces before deployment.
- We need a clean seam between the existing CLI and the future managed service.

Risk:

- It may overfit to local CLI assumptions if not kept deliberately thin.

### Recommendation

Start with Option B only if Miaoda platform access is blocked. Otherwise, prefer
Option A and keep the local CLI as a fixture generator and debugging client.

## Current Local Adapter Slice

This branch implements the Option B fixture path:

```bash
rbrain feishu managed sync --path ~/rbrain-feishu --space-id knowledge_space_xxx --dry-run --json
RBRAIN_AILY_KNOWLEDGE_SPACE_API_TOKEN=... rbrain feishu managed sync --path ~/rbrain-feishu --space-id knowledge_space_xxx
```

The local adapter:

- represents `sources`, `assets`, and `sync_runs` behind a small registry store
- uses a JSON store under `.rbrain-managed/registry.json` by default
- ignores `.rbrain-managed/` in generated mirror Git repos
- works without a local RBrain database when `--path` is provided
- uses registry `content_sha256` to skip unchanged assets
- updates changed Aily assets by deterministic asset title
- returns `base_mirror.preview` rows for the Feishu Base status table
- optionally mirrors rows into a real Base table with `--base-token` and
  `--base-table-id`
- prints the Base field contract with `rbrain feishu managed base-template`
- can create the status table in an existing Base with
  `rbrain feishu managed provision-base`
- prints Postgres DDL for the managed registry with
  `rbrain feishu managed sql-schema`
- applies and verifies the managed Postgres DDL with
  `rbrain feishu managed provision-registry`
- includes a `PostgresManagedRegistryStore` implementation for the same
  snapshot contract, ready to wire to a real Serverless PG / Miaoda runtime
- lets `managed sync` select that Postgres store with
  `--registry-store postgres`, `--registry-url`, or
  `RBRAIN_FEISHU_MANAGED_DATABASE_URL`
- adds `rbrain feishu managed status` so JSON or Postgres registry state can be
  inspected before a full Aily push
- adds `rbrain feishu managed refresh-status` to re-read Aily Knowledge Space
  asset states after asynchronous learning and mirror the refreshed status to
  registry/Base without re-uploading content
- extracts `runManagedSyncJob` so a Miaoda/server-function trigger can reuse
  the same sync implementation instead of shelling out to the CLI
- adds `runManagedTrigger` as the thin server-function adapter for `status`,
  `sync`, and `refresh-status` requests
- lets `runManagedTrigger` sync inline normalized assets supplied in the
  request, so a Miaoda/server-function runtime can hand off one Feishu source
  item without first writing a local mirror file
- validates inline asset request fields at the managed trigger/API boundary so
  malformed Miaoda/server-function payloads fail with stable field-level errors
  before sync or Aily upload begins
- adds `handleManagedTriggerRequest` for HTTP-style server functions with JSON
  request/response handling and error redaction
- prints a deployable TypeScript wrapper with
  `rbrain feishu managed trigger-template`, importing the public
  `gbrain/feishu-managed` adapter and naming only environment variables
- lets generated runtime entrypoints accept explicit serverless env/bindings
  while keeping local smoke tests on `process.env`
- writes a complete starter bundle with `rbrain feishu managed deploy-bundle`,
  including the trigger wrapper, local smoke-test server, runtime
  `package.json`, Postgres DDL, `.env.example`, and deployment README
- lets `trigger-template --source-input inline` and
  `deploy-bundle --source-input inline` generate runtime files that omit
  `RBRAIN_FEISHU_MIRROR_ROOT` and expose a `syncInlineAssets` helper for the
  platform fetch/normalize step
- checks runtime environment readiness with `rbrain feishu managed env-check`
  without printing secret values
- prints a secret-safe, ordered online rollout checklist with
  `rbrain feishu managed deploy-plan`, covering env readiness, registry
  provisioning, trigger deployment, canary checks, status inspection, and the
  final Aily agent answer check
- lets `managed env-check --source-input inline` and
  `managed deploy-plan --source-input inline` validate the online inline path
  without requiring `RBRAIN_FEISHU_MIRROR_ROOT`
- prints or POSTs status/sync/refresh-status trigger probes with
  `rbrain feishu managed probe` so real Miaoda deployments can be smoke-tested
  without hand-written JSON
- lets `managed probe --asset-json` construct inline normalized sync requests
  without a mirror root, so operators can test the Feishu-native handoff path
  with sample content from the CLI
- runs `rbrain feishu managed canary` to execute status first, then dry-run
  sync, then refresh-status against a deployed trigger URL
- lets `managed canary --asset-json` run the same inline asset path through the
  one-command status/sync/refresh-status smoke test
- lets `managed canary --wait-status` poll the deployed refresh-status
  endpoint until Aily reports the requested target state, keeping the long wait
  in the local operator process

It is intentionally not the final managed backend. The sync path now talks to a
registry store boundary, and both the default JSON store and the Postgres store
implement that boundary. The next slice should run the Postgres store against
the real Serverless PG / Miaoda table layer using the generated deployment
bundle.

## Acceptance Criteria

Phase 1 is complete when:

- A managed registry can represent at least one Feishu source and one Aily asset.
- A sync run can create, update, or skip an Aily asset idempotently.
- The resulting state is inspectable without reading `~/.rbrain` or
  `~/rbrain-feishu`.
- A human can see asset status in a Feishu-native surface.
- Real secrets stay out of Git, logs, Base rows, and API responses.
- The existing local `rbrain feishu aily push-space` path still passes tests.

## Suggested Test Plan

Local tests:

- table schema serialization
- deterministic title generation
- hash-based skip
- secret redaction
- Aily create/update/skip mocked responses
- Base mirror mocked responses
- managed status JSON output for registry counts and latest run
- direct `runManagedRegistryProvisionJob` coverage for schema application,
  count readback, and Postgres URL redaction
- direct `runManagedRefreshStatusJob` coverage for Aily status refresh,
  registry persistence, Base mirror handoff, and token redaction
- direct `runManagedWaitStatusJob` coverage for successful Aily learning
  polling, timeout reporting, and persisted final status
- direct `runManagedSyncJob` invocation without the CLI dispatcher
- direct `runManagedTrigger` invocation for server-function `status` and `sync`
  requests, inline normalized asset sync without a mirror root, plus
  request-shape validation and `refresh-status` state refresh
- managed probe/canary request construction with inline normalized assets and
  no mirror root
- HTTP trigger wrapper coverage for method rejection and PostgreSQL URL
  redaction
- generated trigger template coverage for public import path,
  scheduled/status/refresh-status entrypoints, explicit serverless env binding,
  inline source-input helper, and no embedded secrets
- generated deployment bundle coverage for trigger, local smoke-test server,
  package manifest, SQL, env example, README, inline source-input mode, and
  overwrite protection
- managed env-check coverage for required variables, canary refresh-status
  token requirements, optional Base mirror pairing, and no value leakage
- managed deploy-plan coverage for ordered rollout commands, missing config
  blockers, env-file loading, inline source input, and no secret/path leakage
- managed probe coverage for status/sync/refresh-status request generation,
  dry-run default, HTTP POST wiring, and runtime env fallback
- managed canary coverage for status-before-sync sequencing, refresh-status
  after sync, dry-run default, wait-status polling/timeout, and skip behavior
  after status/sync failure

Manual platform checks:

- `managed deploy-plan --url ... --env-file ... --json` returns `ready` or
  clearly names the remaining blocked environment keys.
- The generated `feishu-managed-local-server.ts` can serve the same trigger
  locally and answer `managed canary --status-only`.
- A server-function `sync` request can include inline normalized assets and use
  the Postgres registry without requiring a local mirror root.
- `rbrain feishu managed status --registry-store postgres --registry-ensure-schema`
  can read the target Serverless PG registry.
- Miaoda scheduled/manual trigger runs.
- Serverless PG tables are created and queryable.
- Aily Knowledge Space receives an asset and `managed wait-status` observes it
  reaching `successful`.
- `managed wait-status` persists that `successful` state to the registry/Base
  row.
- Feishu Base shows a readable asset row.
- Aily agent can answer a question using the uploaded asset.

## Open Questions

- Does the target Miaoda runtime support the required PostgreSQL indexes?
- Does it expose any useful migration workflow?
- Can server functions store and use Aily Knowledge Space API tokens safely?
- Should the Base table be created by code or manually for the prototype?
- Can Aily expose retrieved asset metadata for later eval work?
- Should managed sync live under `rbrain feishu managed ...`, a separate
  package, or entirely in Miaoda first?

## Next Implementation Tasks

1. Confirm Miaoda platform access and runtime capabilities.
2. Run `managed provision-registry --registry-url ...` against the target
   Serverless PG / Miaoda table layer, adapting the generated DDL only if the
   platform rejects a Postgres feature.
3. Run `managed deploy-plan --source-input inline --url ... --env-file ...`
   and keep its JSON output as the canonical rollout checklist for the target
   runtime.
4. Run the generated local server and `managed canary --url
   http://127.0.0.1:8787 --status-only` before uploading the trigger.
5. Send one inline normalized Feishu source item through the managed trigger
   and confirm it writes an Aily asset plus registry row.
6. Optionally run `managed sync --registry-store postgres` against the target
   Serverless PG connection as a developer fixture if mirror parity still
   needs validation.
7. Deploy the generated `managed deploy-bundle` output as a real
   manual/scheduled Miaoda trigger using the same registry store.
8. Run `managed env-check --target canary --source-input inline`, then
   `managed canary --asset-json ... --url ... --no-dry-run --wait-status` or
   separate `managed probe` status/sync/refresh-status checks.
9. If the trigger canary is split into separate steps, run `managed
   wait-status` against the same registry store and verify Aily Knowledge Space
   reaches `successful` for a managed sync asset.
10. Verify the Base status row updates without a second content upload.
11. Verify the Aily custom agent answers using the managed asset.
12. Decide whether `managed sync` remains a developer fixture or becomes the
   canonical debugging client for the online control plane.
