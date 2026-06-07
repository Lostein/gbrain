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
- includes a `PostgresManagedRegistryStore` implementation for the same
  snapshot contract, ready to wire to a real Serverless PG / Miaoda runtime
- lets `managed sync` select that Postgres store with
  `--registry-store postgres`, `--registry-url`, or
  `RBRAIN_FEISHU_MANAGED_DATABASE_URL`
- adds `rbrain feishu managed status` so JSON or Postgres registry state can be
  inspected before a full Aily push
- extracts `runManagedSyncJob` so a Miaoda/server-function trigger can reuse
  the same sync implementation instead of shelling out to the CLI
- adds `runManagedTrigger` as the thin server-function adapter for `status` and
  `sync` requests
- adds `handleManagedTriggerRequest` for HTTP-style server functions with JSON
  request/response handling and error redaction
- prints a deployable TypeScript wrapper with
  `rbrain feishu managed trigger-template`, importing the public
  `gbrain/feishu-managed` adapter and naming only environment variables
- writes a complete starter bundle with `rbrain feishu managed deploy-bundle`,
  including the trigger wrapper, Postgres DDL, `.env.example`, and deployment
  README
- checks runtime environment readiness with `rbrain feishu managed env-check`
  without printing secret values
- prints or POSTs status/sync trigger probes with `rbrain feishu managed probe`
  so real Miaoda deployments can be smoke-tested without hand-written JSON
- runs `rbrain feishu managed canary` to execute status first and then dry-run
  sync against a deployed trigger URL

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
- direct `runManagedSyncJob` invocation without the CLI dispatcher
- direct `runManagedTrigger` invocation for server-function `status` and `sync`
  requests
- HTTP trigger wrapper coverage for method rejection and PostgreSQL URL
  redaction
- generated trigger template coverage for public import path, scheduled/status
  entrypoints, and no embedded secrets
- generated deployment bundle coverage for trigger, SQL, env example, README,
  and overwrite protection
- managed env-check coverage for required variables, canary vs real sync token
  requirements, optional Base mirror pairing, and no value leakage
- managed probe coverage for status/sync request generation, dry-run default,
  HTTP POST wiring, and runtime env fallback
- managed canary coverage for status-before-sync sequencing, dry-run default,
  and sync skip behavior after status failure

Manual platform checks:

- `rbrain feishu managed status --registry-store postgres --registry-ensure-schema`
  can read the target Serverless PG registry.
- Miaoda scheduled/manual trigger runs.
- Serverless PG tables are created and queryable.
- Aily Knowledge Space receives an asset and reaches `successful`.
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
2. Execute or adapt the generated Postgres DDL in the target Serverless PG /
   Miaoda table layer.
3. Run `managed sync --registry-store postgres` against the target Serverless
   PG connection.
4. Deploy the generated `managed deploy-bundle` output as a real
   manual/scheduled Miaoda trigger using the same registry store.
5. Run `managed env-check --target canary`, then `managed canary --url ...` or
   separate `managed probe` status/sync
   checks.
6. Verify Aily Knowledge Space reaches `successful` for a managed sync asset.
7. Verify the Aily custom agent answers using the managed asset.
8. Decide whether `managed sync` remains a developer fixture or becomes the
   canonical debugging client for the online control plane.
