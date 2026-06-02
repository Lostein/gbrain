---
id: feishu-to-rbrain
name: Feishu-to-RBrain
version: 0.1.0
description: Feishu docs, Drive/Wiki search, minutes, calendar, tasks, IM, mail, Base, and approvals become a searchable RBrain source.
category: sense
requires: []
secrets: []
health_checks:
  - type: command
    argv: ["lark-cli", "--version"]
    label: "lark-cli"
setup_time: 30 min
cost_estimate: "$0 for Feishu export/mirror; embedding cost depends on your configured provider"
---

# Feishu-to-RBrain

This recipe turns Feishu into the system-of-record input for an RBrain source.
The key decision is intentionally boring: use `lark-cli` for Feishu access,
write deterministic markdown snapshots locally, then let RBrain sync, embed,
link, and synthesize over those files.

## What Gets Mirrored

Use one local repo as the Feishu mirror:

```bash
rbrain feishu setup --path ~/rbrain-feishu
```

Recommended path conventions:

- `feishu/docs/` for cloud docs and docx exports.
- `feishu/drive/` for Drive and Wiki search/discovery snapshots.
- `feishu/wiki/` for wiki-space structure and canonical pages.
- `feishu/minutes/` for Feishu Minutes summaries, chapters, transcripts, and todos.
- `feishu/calendar/` for daily agenda snapshots.
- `feishu/tasks/` for tasks and project follow-ups.
- `feishu/im/` for selected group chats or threads.
- `feishu/mail/` for Feishu Mail digests.
- `feishu/base/` for Base, Bitable, and Sheets exports.
- `feishu/approvals/` for approval records and decision history.
- `feishu/okr/` for OKR snapshots.

These prefixes match the bundled `rbrain-feishu` schema pack.

## Setup

Initialize RBrain. The `rbrain` entrypoint uses `~/.rbrain` by default and
selects the Feishu schema pack automatically.

```bash
rbrain init --pglite
rbrain doctor
```

Confirm Feishu access:

```bash
rbrain feishu doctor
```

This verifies `lark-cli`, auth health, the `rbrain-feishu` schema pack, and the
collector command surface used by the mirror.

Create and register the Feishu mirror as a source:

```bash
rbrain feishu setup --path ~/rbrain-feishu
rbrain feishu status
```

Sync and embed:

```bash
rbrain feishu refresh
rbrain feishu refresh --drive-query "roadmap" --wiki-spaces --mail-query "budget"
rbrain feishu refresh --wiki-space-id my_library
rbrain feishu refresh --approval-tasks --okr-cycles
rbrain feishu refresh --base-token appxxx --base-tables --base-records --base-table-id tblxxx
rbrain feishu refresh --im-query "pricing" --im-flags
rbrain feishu pull agenda --sync
rbrain feishu pull tasks --incomplete --sync
rbrain feishu pull doc "https://example.feishu.cn/docx/..." product-review --sync
rbrain feishu pull docs-list --file ~/rbrain-feishu/feishu/docs/docs-list.tsv --sync
rbrain feishu pull drive-search --query "roadmap" --doc-types docx,wiki --sync
rbrain feishu pull wiki-spaces --page-all --sync
rbrain feishu pull wiki-nodes --space-id my_library --sync
rbrain feishu pull minutes-search "项目复盘" 2026-06-01 2026-06-07 --sync
rbrain feishu pull mail-triage --query "budget" --max 50 --sync
rbrain feishu pull approval-tasks --page-all --sync
rbrain feishu pull approval-initiated --page-all --sync
rbrain feishu pull okr-cycles --time-range 2026-01--2026-06 --sync
rbrain feishu pull okr-cycle-detail --cycle-id 123456 --sync
rbrain feishu pull base-tables --base-token appxxx --sync
rbrain feishu pull base-fields --base-token appxxx --table-id tblxxx --sync
rbrain feishu pull base-records --base-token appxxx --table-id tblxxx --field-id Name --field-id Status --sync
rbrain feishu pull base-search --base-token appxxx --table-id tblxxx --search-json '{"keyword":"Alice","search_fields":["Name"],"limit":20}' --sync
rbrain feishu pull im-chat-list --types group,p2p --sync
rbrain feishu pull im-chat-search --query "项目群" --sync
rbrain feishu pull im-message-search --query "pricing" --sync
rbrain feishu pull im-chat-messages --chat-id oc_xxx --start 2026-06-01T00:00:00+08:00 --sync
rbrain feishu pull im-flags --page-all --sync
rbrain embed --stale --source feishu
```

The generated collection scripts commit their snapshots into the mirror repo,
so RBrain can use the existing incremental Git sync path.

`rbrain feishu refresh` is the daily shortcut: by default it collects today's
agenda plus incomplete tasks and syncs once. Add `--minutes-query TEXT`,
`--drive-query TEXT`, `--wiki-spaces`, `--wiki-space-id SPACE`,
`--mail-query TEXT`, `--approval-tasks`, `--okr-cycles`, `--okr-cycle-id ID`,
`--base-tables`, `--base-records`, `--im-query TEXT`, `--im-chat-id CHAT`, or
`--im-flags` when you want meeting-minutes, Drive/Wiki discovery, Wiki
structure, mail triage, approval workflow context, OKR state, Base data, or
selected IM context included in the same refresh.
Use `rbrain feishu status` when you want a quick readiness view across the
registered source, mirror Git state, local snapshots, `lark-cli`, and the
`rbrain-feishu` schema pack.

For cron or launchd, the generated scripts expose the same collectors:

```bash
~/rbrain-feishu/scripts/refresh-feishu.sh
~/rbrain-feishu/scripts/pull-feishu-agenda.sh
~/rbrain-feishu/scripts/pull-feishu-tasks.sh "项目复盘"
~/rbrain-feishu/scripts/pull-feishu-doc.sh "https://example.feishu.cn/docx/..." product-review
~/rbrain-feishu/scripts/pull-feishu-docs-list.sh ~/rbrain-feishu/feishu/docs/docs-list.tsv --sync
~/rbrain-feishu/scripts/pull-feishu-drive-search.sh "roadmap"
~/rbrain-feishu/scripts/pull-feishu-wiki-spaces.sh
~/rbrain-feishu/scripts/pull-feishu-wiki-nodes.sh my_library
~/rbrain-feishu/scripts/pull-feishu-minutes-search.sh "项目复盘" 2026-06-01 2026-06-07
~/rbrain-feishu/scripts/pull-feishu-mail-triage.sh "budget"
~/rbrain-feishu/scripts/pull-feishu-approval-tasks.sh
~/rbrain-feishu/scripts/pull-feishu-approval-initiated.sh
~/rbrain-feishu/scripts/pull-feishu-okr-cycles.sh 2026-01--2026-06
~/rbrain-feishu/scripts/pull-feishu-okr-cycle-detail.sh 123456
~/rbrain-feishu/scripts/pull-feishu-base-tables.sh appxxx
~/rbrain-feishu/scripts/pull-feishu-base-fields.sh appxxx tblxxx
BASE_FIELD_IDS="Name,Status" ~/rbrain-feishu/scripts/pull-feishu-base-records.sh appxxx tblxxx
~/rbrain-feishu/scripts/pull-feishu-base-search.sh appxxx tblxxx '{"keyword":"Alice","search_fields":["Name"],"limit":20}'
~/rbrain-feishu/scripts/pull-feishu-im-chat-list.sh
~/rbrain-feishu/scripts/pull-feishu-im-chat-search.sh "项目群"
~/rbrain-feishu/scripts/pull-feishu-im-message-search.sh "pricing"
IM_START="2026-06-01T00:00:00+08:00" ~/rbrain-feishu/scripts/pull-feishu-im-chat-messages.sh oc_xxx
~/rbrain-feishu/scripts/pull-feishu-im-flags.sh
```

For a stable set of product docs, maintain `feishu/docs/docs-list.tsv` with one
document per line:

```text
https://example.feishu.cn/docx/xxxx	product-review
weekly-review	https://example.feishu.cn/docx/yyyy
```

## Suggested Collection Jobs

Start with low-risk read-only mirrors before wiring automation.

```bash
# Cloud docs and Drive folders
lark-cli drive +pull --help
lark-cli drive +search --help

# Wiki spaces and nodes
lark-cli wiki +space-list --help
lark-cli wiki +node-list --help

# Specific cloud docs
lark-cli docs +fetch --api-version v2 --help

# Meeting minutes
lark-cli minutes +search --help

# Calendar agenda
lark-cli calendar +agenda --help

# Tasks assigned to you
lark-cli task +get-my-tasks --help

# IM chats, messages, and bookmarks
lark-cli im +chat-list --help
lark-cli im +chat-search --help
lark-cli im +chat-messages-list --help
lark-cli im +messages-search --help
lark-cli im +flag-list --help

# Tasks, mail, Base, approvals, OKR
lark-cli mail --help
lark-cli base --help
lark-cli base +table-list --help
lark-cli base +field-list --help
lark-cli base +record-list --help
lark-cli base +record-search --help
lark-cli approval --help
lark-cli approval tasks query --help
lark-cli approval instances initiated --help
lark-cli okr --help
lark-cli okr +cycle-list --help
lark-cli okr +cycle-detail --help
```

Each collector should write markdown with Feishu provenance in frontmatter:

```markdown
---
type: feishu-doc
title: Example Product Review
feishu_token: doccnxxxxxxxx
feishu_url: https://example.feishu.cn/docx/...
owner: someone@example.com
collaborators:
  - teammate@example.com
captured_via: lark-cli
updated_at: 2026-06-01T00:00:00+08:00
---

# Example Product Review

...
```

## Operating Model

Keep the mechanism split clean:

- Feishu remains the collaboration and permission surface.
- `lark-cli` is the deterministic export and mirror layer.
- RBrain is the private retrieval, graph, synthesis, and gap-analysis layer.
- Agent skills decide what to collect, summarize, enrich, or ask the user to confirm.

For enterprise use, do not hide governance inside prompt text. Use explicit
source registration, Feishu permissions, audit logs, confirmation gates for
write-back, and externalized secrets.

## Verification

```bash
rbrain feishu status
rbrain schema active
rbrain search "recent Feishu decisions" --source feishu
rbrain think "what changed in my Feishu docs this week?"
rbrain graph-query feishu/minutes/<meeting-slug> --depth 2
```

The first useful milestone is not full automation. It is proving that a few
docs, one meeting, and today's calendar can be mirrored, searched, cited, and
connected without leaking outside your Feishu source boundary.
