# RBrain

RBrain is the Feishu-first fork of GBrain for building a personal or team
memory layer on top of Feishu/Lark work artifacts. It keeps the mature GBrain
retrieval engine, knowledge graph, MCP server, job queue, and skillpack
machinery, but changes the default operating mode around your Feishu workflow.

The first usable shape is:

- `rbrain` command alias with its own `~/.rbrain` home directory.
- `rbrain-feishu` schema pack for Feishu docs, Drive/Wiki discovery, minutes,
  calendar, tasks, IM, mail, Base, approvals, and OKR.
- `feishu-to-rbrain` integration recipe that uses `lark-cli` as the bridge from
  Feishu into local markdown, including daily refreshes and manifest-based doc
  imports, Drive/Wiki search snapshots, Wiki space/node discovery, and read-only
  mail triage, OKR, approval workflow, Base, and IM snapshots,
  then lets RBrain sync, embed, link, and synthesize.

For setup details, start with [`docs/rbrain/feishu.md`](docs/rbrain/feishu.md)
and [`recipes/feishu-to-rbrain.md`](recipes/feishu-to-rbrain.md).

Under the hood, this is still GBrain: **search gives you raw pages; the brain
layer gives you synthesized answers with citations, graph traversal, and gap
analysis.** The Feishu adaptation keeps Feishu as the collaboration and
permission surface, uses `lark-cli` for deterministic export/mirroring, and
uses RBrain as the private retrieval and reasoning layer.

> **LLMs:** fetch [`llms.txt`](llms.txt) for the documentation map, or
> [`llms-full.txt`](llms-full.txt) for the same map with core docs inlined in
> one fetch. **Agents:** start with [`AGENTS.md`](AGENTS.md) (or
> [`CLAUDE.md`](CLAUDE.md) if you're Claude Code).

## What this looks like

Say you have a meeting with Alice tomorrow. You want to walk in remembering what she works on, when you last talked, and what's still open between you. Here's what you'd type, and what you'd get back.

**You ask:**

> "What do I need to know before my meeting with Alice tomorrow?"

**Most personal-knowledge tools give you back a list of pages.** Something like:

```
1. people/alice — Alice runs engineering at Acme...
2. meetings/2026-03-15-alice-q1 — Q1 product review with Alice...
3. meetings/2026-01-08-acme-kickoff — Kickoff meeting with Acme team...
4. customers/acme — Acme is a series-B fintech we work with...
5. notes/2026-04-22 — Quick chat with Alice about pricing...
```

Five pages you now have to open and read yourself to actually prepare. The tool found the right material, but it didn't do the work.

**GBrain gives you back the answer, with sources:**

```
Alice runs engineering at Acme (a series-B fintech). You last spoke
on April 22 in a quick pricing chat. Three things are still open
from that conversation:

1. She owes you the security review for the new tier
   (deadline was May 1; no update since).
2. You committed to pricing for a 500-seat tier
   (you sent it April 25; no response yet).
3. She mentioned they're hiring a CISO; you said you'd intro
   someone from your network.

Heads up: nothing's been added to the brain about Alice or Acme
since April 22, six weeks ago. She may have replied through email
or Slack DM, channels the brain doesn't see. Worth asking her to
catch up before assuming any of this is still current.
```

Every claim has a source page behind it. The "heads up" at the end tells you what the brain doesn't know yet, so you can ask Alice about it directly instead of being surprised. The brain just did your meeting prep.

This is the difference between a search engine and a brain. Search finds the pages. The brain reads them for you and writes the answer.

## Install

For this fork, start from the `rbrain` command. It uses `~/.rbrain` by default
and activates the `rbrain-feishu` schema pack automatically, so it will not
collide with an existing `gbrain` install.

### Local checkout

Use this when you are developing or running directly from this repo:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun link
rbrain --version
```

### Global install

After this fork is pushed, a machine can install it directly:

```bash
bun install -g github:Lostein/gbrain
rbrain --version
```

The package still ships the original `gbrain` binary for compatibility. Use
`rbrain` for Feishu-first workflows.

For zero-config local PGLite, prefer the Bun-linked or globally installed
`rbrain` command above. The compiled repo-local `bin/rbrain` binary is mainly
for packaged/plugin use and Postgres-backed deployments; on some Bun versions it
can fail to open a fresh PGLite brain because the PGLite data file is trapped
inside Bun's virtual filesystem.

### First RBrain setup

```bash
rbrain init --pglite
rbrain doctor
rbrain feishu doctor
rbrain feishu setup --path ~/rbrain-feishu
rbrain feishu refresh
rbrain search "recent Feishu decisions" --source feishu
```

`rbrain feishu doctor` uses your real installed `lark-cli`. Temporary fake
`lark-cli` binaries are useful only for isolated tests; live use should go
through the current authenticated Feishu CLI on the machine. Personal agenda,
tasks, minutes, Mail, and IM pulls require a valid Feishu user login; bot auth
alone is not enough for those user-scoped views.

Postgres-at-scale, Supabase, and thin-client setup paths are inherited from
GBrain and live in [`docs/INSTALL.md`](docs/INSTALL.md). Feishu-specific setup
details live in [`docs/rbrain/feishu.md`](docs/rbrain/feishu.md).

### Connect RBrain to your AI client (MCP)

RBrain exposes the same 30+ MCP tools as GBrain (stdio and HTTP), with the
Feishu schema and `~/.rbrain` home selected by default. The specific snippet
depends on which client you use:

- **[Claude Code](docs/mcp/CLAUDE_CODE.md)** — one command: `claude mcp add rbrain -- rbrain serve`. Zero server, zero tunnel.
- **[Cursor / Windsurf / any stdio MCP client](docs/mcp/CLAUDE_CODE.md)** — same shape, add `{"command": "rbrain", "args": ["serve"]}` to your MCP config.
- **[Claude Desktop (Cowork)](docs/mcp/CLAUDE_DESKTOP.md)** — Settings → Integrations → add the URL of your HTTP server. Remote only; the local `claude_desktop_config.json` does not work for remote servers.
- **[Claude Cowork (team plan)](docs/mcp/CLAUDE_COWORK.md)** — org Owner adds the connector under Organization Settings → Connectors.
- **[Perplexity Computer](docs/mcp/PERPLEXITY.md)** — Settings → Connectors → add the URL + bearer token. Pro subscription required.
- **[ChatGPT](docs/mcp/CHATGPT.md)** — uses OAuth 2.1 with PKCE (the hard requirement). Register a `chatgpt` client from the admin dashboard with grant type `authorization_code`.

For the HTTP server itself:

```bash
rbrain serve              # stdio MCP (local subprocess; for Claude Code, Cursor, Windsurf)
rbrain serve --http       # HTTP MCP with OAuth 2.1 + admin dashboard at /admin
                          # (required for Claude Desktop, Cowork, Perplexity, ChatGPT)
```

The HTTP server includes DCR-style client registration, scope-gated access (`read` / `write` / `admin`), and rate limiting. Deployment guides (ngrok, Railway, Fly.io) live under [`docs/mcp/`](docs/mcp/).

## Two ways to query your brain

Raw retrieval (what most personal-knowledge tools ship) and a synthesis layer that gives you an actual answer. They serve different jobs.

```bash
# raw retrieval: top pages by hybrid score, fast, no LLM cost
rbrain search "recent Feishu decisions" --source feishu

# brain layer: synthesized answer with citations and gap analysis
rbrain think "what should I know from Feishu before today's meetings?"
```

**`rbrain search`** returns the top retrieved pages, ranked by hybrid scoring (vector + keyword + RRF + source-tier boost + reranker). Use it when you want raw material to skim: agent context windows, citation lookups, finding a specific quote.

**`rbrain think`** runs the same retrieval, then composes a synthesized answer across the results with explicit citations to the source pages AND an honest note on what the brain doesn't know yet. The gap analysis is the differentiator: the answer tells you when a page is stale, when a claim is uncited, when two pages contradict each other, when there's a hole you should fill.

**Why it compounds.** Pair the brain layer with `find_trajectory` and you get answers like *"how have the company's metrics changed AND what does the team look like right now AND what did they promise / share AND when did we last meet AND what's the value-add I can offer here"*: well-scored, well-cited, in one shot. That's the strategic moat. That's why building a 100K-page brain is worth the effort.

`rbrain agent run "..."` exposes the same surface to a sub-agent through the Minions queue, with crash-safe two-phase persistence. Same answers, durable.

## How to get data in

One command, local or hosted, synchronous receipt:

```bash
rbrain capture "the thought I want to remember"
rbrain capture --file ./notes/today.md
echo "from a pipe" | rbrain capture --stdin
SLUG=$(rbrain capture "..." --quiet)
```

The page lands in the database and on disk in one move. Default slug `inbox/YYYY-MM-DD-<hash8>` so captures cluster in a predictable triage location. On thin-client installs the verb routes through MCP to the server: same command, same UX.

For webhook ingestion (Zapier / IFTTT / Apple Shortcuts):

```bash
curl -X POST https://your-brain/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  -d "# a thought from a Shortcut"
```

For mobile capture, the inbox folder source picks up anything dropped into
`~/.rbrain/inbox/` from iOS Shortcuts / AirDrop / Drafts / Finder.

Third-party skillpacks can ship custom ingestion sources (Granola, Linear,
voice, OCR) against the versioned `IngestionSource` contract at
`gbrain/ingestion`. See [`docs/skillpack-anatomy.md`](docs/skillpack-anatomy.md).

## Your brain's shape (schema packs)

Most personal-knowledge tools force one fixed layout: their idea of "notes" + "people" + "tags." Drop a Notion export or your own years-old Obsidian vault on top, and the agent doesn't know what a `Projects/` folder means or whether `Reading/` is people or sources.

**RBrain does not have a fixed layout.** It inherits GBrain's bundled schema
pack system and starts from `rbrain-feishu`, while still letting you author
your own when none fit:

- **`gbrain-base-v2`** (default as of v0.41.22) — 15-type DRY/MECE canonical taxonomy (14 canonical + `note` catch-all): `person`, `company`, `media`, `tweet`, `social-digest`, `analysis`, `atom`, `concept`, `source`, `deal`, `email`, `slack`, `writing`, `project`, `note`. Subtypes/format/origin pushed to frontmatter. The taxonomy that responds to issue #1479.
- **`gbrain-base`** (legacy, v0.41 and earlier brains) — the original 24-type layout. Stays bundled for back-compat; brains on it can upgrade via `rbrain onboard --check --explain` → `rbrain jobs submit unify-types --allow-protected --params '{"target_pack":"gbrain-base-v2"}'`.
- **`gbrain-recommended`** — extends `gbrain-base` with the 13 additional directories from `docs/GBRAIN_RECOMMENDED_SCHEMA.md` (source, place, trip, conversation, personal, civic, project, etc.). Activate with `rbrain schema use gbrain-recommended`.
- **Your own pack** — `rbrain schema detect` clusters your actual filesystem into proposed types, `rbrain schema suggest` runs an LLM pass over them, and `rbrain schema review-candidates --apply` promotes the ones you like. Three commands and the brain knows your shape. Authoring a successor pack (declares `migration_from:` so existing brains can opt in): see [`docs/architecture/pack-upgrade-mechanism.md`](docs/architecture/pack-upgrade-mechanism.md).

```bash
rbrain schema active                # which pack is running, which tier set it
rbrain schema list                  # bundled + installed packs
rbrain schema detect                # propose types matching your filesystem
rbrain schema suggest               # LLM-refined proposals on top of detect
rbrain schema review-candidates     # human gate: promote / rename / ignore
rbrain schema use my-pack           # activate
```

The active pack threads through every read + write path: `parseMarkdown` infers page type from the pack's path prefixes; `whoknows` scopes expert routing to types declared `expert_routing: true`; `extract_facts` runs only on `extractable: true` types; the search cache folds the pack name + version into its key so cross-pack contamination is structurally impossible. Switch packs and the brain re-interprets itself; switch back and nothing's lost.

Seven-tier resolution chain (per-call flag → env var → per-source DB key → brain-wide DB key → `gbrain.yml` → `~/.rbrain/config.json` in RBrain mode → `rbrain-feishu` default). Full reference + authoring guide: [`docs/architecture/schema-packs.md`](docs/architecture/schema-packs.md).

## Tutorials

Step-by-step walkthroughs for getting the most out of GBrain. Each one takes you from zero to a working outcome, with concrete commands and real numbers.

- [**Set up your personal AI agent + brain from zero**](docs/tutorials/personal-brain.md) — the canonical full-stack install. Two GitHub repos, a Telegram bot, AlphaClaw on Render, OpenClaw + GBrain + Supabase. End-to-end in about 2 hours.
- [**Set up GBrain as your company brain**](docs/tutorials/company-brain.md) — federated, multi-user, OAuth-scoped institutional memory for a 10-50 person team. About 90 minutes end-to-end.

More walkthroughs in progress: connecting an existing agent (Claude Code, Cursor, OpenClaw, Hermes) to a GBrain memory layer; setting up GBrain for VC dealflow with founder scorecards and meeting prep; migrating an existing Notion or Obsidian vault; indexing a codebase as a queryable code brain. Full tutorial index: [`docs/tutorials/`](docs/tutorials/).

Want to see a tutorial that isn't here yet? [Open an issue](https://github.com/garrytan/gbrain/issues) describing the workflow you want documented.

## What it does (the loop)

```
  signal   →   search   →   respond   →   write   →   auto-link   →   sync
  (every    (brain-first  (informed     (page +    (typed edges     (cron
  message)  retrieval)    by context)   timeline)  + backlinks)     keeps fresh)
```

- **Signal detector** runs on every message your agent receives. Captures ideas, entity mentions, time-sensitive todos, names, links.
- **Brain-first lookup** before any external API call. The cheapest, fastest, most personal information source you have.
- **Auto-link** fires on every page write. No LLM calls; pure pattern matching on `[[wiki/people/bob]]` style references. New entity → new page stub → graph grows.
- **Cron-driven enrichment** runs while you sleep: dedup people pages, fix citations, score salience, find contradictions, prep tomorrow's tasks.

The whole loop is described in [`docs/architecture/topologies.md`](docs/architecture/topologies.md) with diagrams.

## Capabilities

**Hybrid search.** Vector (HNSW on pgvector) + BM25 keyword + reciprocal-rank fusion + source-tier boost + intent-aware query rewriting. Three named search modes (`conservative`, `balanced`, `tokenmax`) bundle the cost/quality knobs into a single config key. Live cost/recall comparisons in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md). Default: `balanced` with ZeroEntropy reranker on. Per-query graph signals notice when a top result is a hub for THAT query (adjacency boost), is corroborated across team brains (cross-source boost), or is being crowded out by weak chunks from a chatty session (session demote). Run `rbrain search "<query>" --explain` to see per-stage attribution: base score, every boost that fired, what it multiplied. `rbrain doctor` ships a `graph_signals_coverage` check; `rbrain search stats` shows fire counts and failure breakdowns.

**Self-wiring knowledge graph.** Every `put_page` extracts entity refs from markdown/wikilinks/typed-link syntax and writes edges with zero LLM calls. Typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, …). Multi-hop traversal via `rbrain graph-query`. The graph is what produces the +31.4 P@5 lift over vector-only RAG.

**Job queue (Minions).** BullMQ-shaped, Postgres-native job queue. Durable subagents (LLM tool loops that survive crashes via two-phase pending→done persistence), shell jobs with audit, child jobs with cascading timeouts, rate leases for outbound providers, attachments via S3/Supabase storage. Replaces "spawn subagent as fire-and-forget Promise" with something that recovers from anything.

**43 curated skills.** Routing lives in [`skills/RESOLVER.md`](skills/RESOLVER.md). Covers signal capture, ingest (idea / media / meeting), enrichment, querying, brain ops, citation fixing, daily task management, cron scheduling, reports, voice, soul audit, skill creation, eval framework, and migrations. Skills are markdown files (tool-agnostic), packaged as a single skillpack the installer drops into your agent workspace.

**Eval framework.** `rbrain eval longmemeval` runs the public [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) benchmark against your hybrid retrieval. `rbrain eval export` + `rbrain eval replay` capture real queries and replay them against code changes (set `GBRAIN_CONTRIBUTOR_MODE=1`). `rbrain eval cross-modal` cross-checks an output against the task using three different-provider frontier models. Full methodology in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md).

**Brain consistency.** `rbrain eval suspected-contradictions` samples retrieval pairs, layered date pre-filter, query-conditioned LLM judge, persistent cache. Surfaces conflicts between takes + facts the agent has written. Wired into the daily dream cycle.

**Agent-authored schema (v0.40.7.0).** Your brain has a shape — what page types exist (`person`, `meeting`, `paper`, `case`, `lab-result`), what they link to (`attended`, `authored`, `prescribed-by`), what facts get extracted automatically. The default ships with 22 universal types, but your brain's actual shape is not the default shape. Agents can now evolve that shape on your behalf via 14 `rbrain schema` CLI verbs + a batched MCP op (`schema_apply_mutations`, admin scope, NOT localOnly so remote agents reach it over HTTPS). Atomic file locks, audit log with the agent's identity, chunked UPDATE backfill in 1000-row batches that never wedge concurrent writers. The brain stops being a pile of notes and becomes something with structure. **Why it matters:** [`docs/what-schemas-unlock.md`](docs/what-schemas-unlock.md) — 7 killer use cases (4000 invisible meetings, founder ops brain, research brain, legal brain, team brain, agent-as-co-curator). **5-minute walkthrough:** [`docs/schema-author-tutorial.md`](docs/schema-author-tutorial.md). **Agent skill:** [`skills/schema-author/SKILL.md`](skills/schema-author/SKILL.md).

## Integrations

Data flowing into the brain. Each integration is a recipe — markdown + setup hints — that ships in `recipes/` and is discoverable via `rbrain integrations list`.

- **Voice**: Phone calls create brain pages via Twilio + OpenAI Realtime (or DIY STT+LLM+TTS). Setup recipe: [`recipes/twilio-voice-brain.md`](recipes/twilio-voice-brain.md).
- **Email + calendar**: webhook handlers that route to brain signals. [`docs/integrations/meeting-webhooks.md`](docs/integrations/meeting-webhooks.md).
- **Embedding providers**: 16 recipes covering OpenAI (default fallback), OpenRouter, Voyage, ZeroEntropy (default), Google Gemini, Azure OpenAI, MiniMax, Alibaba DashScope, Zhipu, Ollama (local), llama.cpp llama-server (local), LiteLLM proxy. Pricing matrix + decision tree in [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md).
- **Rerankers**: ZeroEntropy `zerank-2` hosted (default in `tokenmax` mode) plus the v0.40.6.1 `llama-server-reranker` recipe for fully-local cross-encoder rerank via llama.cpp — runs Qwen3-Reranker or self-hosted ZeroEntropy weights against the same `gateway.rerank()` seam. Setup walkthrough in [`docs/ai-providers/llama-server-reranker.md`](docs/ai-providers/llama-server-reranker.md).
- **Credential gateway**: vault-aware secret distribution. [`docs/integrations/credential-gateway.md`](docs/integrations/credential-gateway.md).
- **MCP clients**: every major MCP client is supported. [`docs/mcp/`](docs/mcp/) per-client setup.

## Architecture

**Two engines, one contract.** PGLite (Postgres 17 via WASM, zero-config, default) for personal brains up to ~50K pages. Postgres + pgvector (Supabase or self-hosted) for shared / large / multi-machine deployments. The contract-first `BrainEngine` interface in [`src/core/engine.ts`](src/core/engine.ts) defines ~47 operations both engines implement; CLI and MCP server are generated from one source.

**Brain repo is the system of record.** Your knowledge lives in a regular git repo (your "brain repo") as markdown files. GBrain syncs the repo into Postgres for retrieval; deletes in git become soft-deletes in DB. You can publish public subsets, share team mounts, run thin-client setups pointing at a colleague's brain server. Topologies in [`docs/architecture/topologies.md`](docs/architecture/topologies.md).

**Two organizational axes (brain ⊥ source).** A *brain* is a database (your personal brain, a team mount you joined). A *source* is a repo inside that brain (wiki, gstack, an essay, a knowledge base). Routing lives in `.gbrain-source` dotfiles and resolves via a documented 6-tier precedence chain. Full diagrams in [`docs/architecture/brains-and-sources.md`](docs/architecture/brains-and-sources.md).

**Why the graph matters.** Vector search returns chunks that are semantically close. The graph returns chunks that are factually connected. Hybrid search pulls from both; auto-linking on every write keeps the graph fresh. Deep dive: [`docs/architecture/RETRIEVAL.md`](docs/architecture/RETRIEVAL.md).

## Troubleshooting

**`rbrain import` fails with `expected N dimensions, not M`?** Run `rbrain doctor`. It will print the exact `rbrain config set ...` or `rbrain retrieval-upgrade` command to repair the mismatch. You should not need to delete `~/.rbrain`. Fresh `rbrain init --pglite` auto-detects your embedding provider from API keys in your environment: set `OPENAI_API_KEY` (or `ZEROENTROPY_API_KEY` / `VOYAGE_API_KEY`) before running init, or pass `--embedding-model <provider>:<model>` explicitly. With multiple keys set, init fires an interactive picker. In non-TTY contexts (CI, Docker) with no keys, init exits 1 with a paste-ready setup hint; pass `--no-embedding` to defer setup until runtime. See [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md) for the full provider matrix and [`docs/operations/headless-install.md`](docs/operations/headless-install.md) for Docker/CI sequencing.

**Hourly cron sync keeps timing out on a federated brain?** v0.41.13.0 ships
two flags + a recommended pattern. Switch your cron to a per-source loop
with shell `timeout(1)` doing the OS-level kill and gbrain self-terminating
gracefully half-a-minute earlier:

```bash
rbrain sync --break-lock --all --max-age 1800
for src in $(rbrain sources list --json | jq -r '.[].id'); do
  timeout 600 rbrain sync --source "$src" --timeout 540 || true
done
```

When `--timeout` fires mid-import, `rbrain sync` exits 0 with status
`partial` and `last_commit` UNCHANGED — the next run re-walks the same
diff and `content_hash` short-circuits already-imported files. The
`--max-age 1800` first command self-heals any wedged-but-alive locks
left by a hung previous run, using the v98 `last_refreshed_at` semantic
(NOT `acquired_at`) so healthy long-running holders are safe by
construction. See the v0.41.13.0 entry in [`CHANGELOG.md`](CHANGELOG.md)
for the honest scope notes (extract + embed phases run to completion;
30-min rollout window for `--max-age` post-migration v98; full-sync
triggers deferred to v0.42+).

**Dream cycle silently losing wiki links on Supabase?** v0.41.19.0 fixes
the bug class structurally. The engine now self-retries every bulk batch
write (`addLinksBatch` / `addTimelineEntriesBatch` / `upsertChunks`) on
Supavisor pooler blips, with a 12s worst-case wait that covers the full
5-10s circuit-breaker recovery window. `rbrain doctor` surfaces incidents
via the new `batch_retry_health` check (reads the last 24h of
`~/.rbrain/audit/batch-retry-YYYY-Www.jsonl`). To tune for an unusually
slow pooler:

```bash
# Defaults: 3 retries, base 1s, max 10s, decorrelated jitter.
# Override per operator without a release:
export GBRAIN_BULK_MAX_RETRIES=5       # int >= 0; 0 disables retries
export GBRAIN_BULK_RETRY_BASE_MS=2000  # int > 0
export GBRAIN_BULK_RETRY_MAX_MS=15000  # int >= base
```

Bad values surface at `rbrain doctor` startup with a paste-ready fix
(not at first-retry mid-cycle). PGLite-only installs pay zero cost — the
retry wrap is engine-level, but PGLite has no pooler so retries never
fire in practice.

**Dream cycle losing ~150 link rows per run with `'No database
connection: connect() has not been called'` errors in the log?** v0.41.27.0
makes the retry layer self-heal on a nulled-out database singleton. A
new `reconnect` callback on `withRetry` rebuilds the connection between
attempts; `PostgresEngine.batchRetry` injects `() => this.reconnect()`
so engine-level batch writes survive a mid-cycle disconnect by something
else in the same process. Same release: `rbrain capture` no longer trails
a `'No database connection'` stderr line from a background facts:absorb
worker firing after CLI exit — the op-dispatch finally block awaits
`getFactsQueue().drainPending({timeout: 1000})` before
`engine.disconnect()`. To find which code path is still calling
disconnect mid-process, run `rbrain doctor --json | jq '.checks[] |
select(.id=="batch_retry_health")'`; the extended check now surfaces
24h disconnect-call count and the most-recent caller frame from a new
`~/.rbrain/audit/db-disconnect-YYYY-Www.jsonl` audit. (Closes #1570.)

**`rbrain brainstorm` returning `judge_failed: true` with 0 scored
ideas?** v0.41.21.0 closes the two bugs that caused it. The judge
hard-coded a 4K-token output cap; for any run past ~40 ideas the call
truncated mid-JSON and the parser threw. Same release closes a slash-
form pricing miss: `rbrain brainstorm --judge-model
anthropic/claude-sonnet-4-6 --max-cost 5` failed with
`BudgetExhausted reason=no_pricing` because every pricing site only
matched the colon form. Both shapes work now. No config change, no
schema migration — `rbrain upgrade` is the whole fix.

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — every install path, end to end
- [`docs/what-schemas-unlock.md`](docs/what-schemas-unlock.md) — why schemas matter: 7 killer use cases, the structural argument for typed page kinds, the agent-co-curates pattern (v0.40.7.0)
- [`docs/schema-author-tutorial.md`](docs/schema-author-tutorial.md) — 5-minute walkthrough: fork the bundled pack, add a custom type, backfill existing pages, prove the wiring via `rbrain whoknows`
- [`docs/architecture/`](docs/architecture/) — system design, topologies, retrieval theory
- [`docs/guides/`](docs/guides/) — how-to runbooks (sub-agent routing, minion deployment, skill development, brain-first lookup, idea capture, diligence ingestion)
- [`docs/integrations/`](docs/integrations/) — connecting external data sources (voice, email, calendar, embedding providers)
- [`docs/mcp/`](docs/mcp/) — per-client MCP setup (Claude Desktop, Code, Cursor, ChatGPT, Perplexity, Cowork)
- [`docs/eval/`](docs/eval/) — eval framework, metric glossary, methodology
- [`docs/ethos/`](docs/ethos/) — philosophy (thin harness, fat skills, markdown as recipes, origin story)
- [`AGENTS.md`](AGENTS.md) — entry point for non-Claude agents
- [`CLAUDE.md`](CLAUDE.md) — entry point for Claude Code (deep operating context)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor guide, test discipline, eval-capture mode
- [`SECURITY.md`](SECURITY.md) — OAuth threat model, hardening defaults

## Contributing

Run `bun run test` for the fast loop, `bun run verify` for the pre-push gate, `bun run ci:local` to run the full Docker-backed CI stack locally. Detailed test discipline in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Community PRs are batched into release waves rather than merged one-by-one — see the "PR wave workflow" section in [`CLAUDE.md`](CLAUDE.md). Contributor attribution stays attached via `Co-Authored-By:` trailers. We credit every accepted contribution in [`CHANGELOG.md`](CHANGELOG.md).

If you find a bug or want a feature: open an issue first. Quick fixes (typo, doc bug, obvious regression) can go straight to a PR. Anything touching schema, retrieval ranking, MCP protocol, or the security boundary needs a design discussion in the issue first.

## License + credit

MIT. I built GBrain to run my OpenClaw and Hermes deployments — the production brain behind my AI agents.

Origin story: [`docs/ethos/ORIGIN.md`](docs/ethos/ORIGIN.md).

Community PR contributors are credited in `CHANGELOG.md` per release. ZeroEntropy ([@zeroentropy](https://zeroentropy.dev)) for the embedding + reranker stack that ships as the default. Voyage AI for the asymmetric-encoding recipe template. Ramp Labs for the search quality improvements lineage.
