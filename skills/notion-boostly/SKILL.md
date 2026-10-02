---
name: notion-boostly
description: Create, read, and update pages in the Boostly Notion workspace. Use when Travisse asks to publish docs, PRDs, roadmaps, meeting notes, or any content to Boostly Notion — or to search/read existing Boostly pages. Separate from /notion-backlog (which is scoped to the personal Life Backlog DB).
---

# Notion Boostly Workspace

General-purpose Notion tool for the **Boostly workspace**. Unlike `/notion-backlog`, this is not tied to a database — it operates on arbitrary pages and hierarchies so you can create PRDs, docs, roadmaps, and nested child pages.

## Workspace

- **Workspace:** Boostly
- **Integration name:** Claude Code - Travisse
- **Bot user id:** `53dd4859-7446-4409-b95f-4646842f30b1`

**IMPORTANT — sharing requirement.** The integration only sees pages it has been explicitly connected to. If a `read`/`create`/`search` returns nothing or says "object not found", the page hasn't been shared yet: open it in Notion → `⋯` menu → **Connections** → add **Claude Code - Travisse**. Access inherits to children, so connecting at the highest allowed ancestor is best.

## CLI Tools

**Do NOT use the Notion MCP — it is unreliable for this workspace. Do NOT use the Life Backlog CLI (`notion.js`), which points at the personal workspace.**

For saving artifacts to the **Travisse AI Output** database, use the shared `ntn` wrapper with the Boostly workspace flag:

```bash
~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create "Title" "Category" [content|@file|-]
```

For general Boostly workspace page operations outside the AI Output database, use the same wrapper with `--workspace boostly`. Do not call deleted legacy scripts. Examples:

```bash
~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly search "Product Roadmap" page
~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly read <pageId>
~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create-page <parentPageId> @/tmp/draft.md
```

## Commands

| Command | Purpose |
|---|---|
| `whoami` | Verify the integration token |
| `search "query" [page\|database]` | Find pages/databases the integration can see |
| `read <pageId>` | Read a page's content |
| `create-page <parentPageId> [content\|@file\|-]` | Create a child page under an existing page |
| `edit <pageId> [content\|@file\|-]` | Replace a page's Markdown body |
| `create "Title" "Category" [content\|@file\|-]` | Create an entry in the Boostly Travisse AI Output database |

## Travisse AI Output database

Default dumping ground for AI-generated artifacts in Boostly Notion.

- **Parent page id:** `33bc831c-671e-8079-948d-c824b98f58d0`
- **Database id:** `33bc831c-671e-8137-a524-f62347485d71`
- **URL:** https://www.notion.so/33bc831c671e8137a524f62347485d71
- **Category options:** `research`, `prds`, `marketing`

When Travisse says "put this in Travisse AI Output" (or similar), use `notion-ai-ntn.sh --workspace boostly` and pick the appropriate category. Example:

```bash
~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create "Tapcards onboarding PRD" "prds" @/tmp/draft.md
```

The command returns the new page's id/url. It writes Markdown through the official `ntn` CLI so links render correctly, then patches the Boostly database `Name` and `Category` properties.

Content arguments accept three forms:
- Inline string: `"# Heading\n- bullet"`
- File reference: `@/tmp/draft.md`
- Stdin: `-` (pipe content in)

## Images (local files)

The markdown converter does NOT support images. To embed a local image (e.g., a matplotlib chart PNG) into a Notion page, use the dedicated image uploader — it uses Notion's native `/v1/file_uploads` endpoint, so no external hosting is required.

```bash
node ~/.config/notion-tools/notion-image-upload.js --workspace boostly <pageId> <filepath> "optional caption"
```

Always use this tool for images in Boostly pages. Do not reference local paths in markdown (they won't render) and do not try to embed base64 (Notion API rejects it). If Travisse asks for "charts/screenshots in Notion", generate the PNG (e.g., with matplotlib), then call this uploader for each file. The block is appended to the page in call order — interleave `append` (for text/tables) and `notion-image-upload.js` (for images) to control layout.

## Markdown Support

The converter handles: `#`/`##`/`###` headings, `-` / `*` bullets, `1.` numbered lists, `[ ]` / `[x]` todos, `> quote`, `---` divider, inline `**bold**`, `*italic*`, `` `code` ``, `[text](url)`, and **markdown tables** (first row = header, second row = `|---|---|` separator, remaining rows = body — rendered as native Notion table blocks). Fenced code blocks are stripped.

## Typical Workflows

### Creating a new doc in Boostly
1. `search "Parent Area Name"` to find where it belongs.
2. Copy the `id` of the target parent page.
3. `~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create-page <parentId> @/tmp/draft.md`
4. Share the returned URL with Travisse.

### Nesting pages (page within page within page)
Each `create` call returns an `id`. Pass that id as the parent for the next `create` to nest deeper. Example:
```bash
ROOT=$(~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create-page <boostlyParentId> @/tmp/overview.md | jq -r .id)
SUB=$(~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create-page "$ROOT" @/tmp/tapcards.md | jq -r .id)
~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create-page "$SUB" @/tmp/rollout.md
```

### Updating an existing doc
For additive updates, fetch the page Markdown with `read`, append locally, then write back with `edit <pageId> @/tmp/current-plus-new-section.md`. Only rewrite the whole body when Travisse explicitly wants the body rewritten.

### Drafting long content
Write the markdown to a temp file (`/tmp/<name>.md`) and pass with `@/tmp/<name>.md`. This avoids shell-escaping issues and handles >100-block content correctly (the CLI auto-chunks).

## Gotchas

- **Permission errors** = page not shared with the integration. Don't assume the token is broken — try `whoami` first, then check connections on the target page.
- **Search returns empty** = nothing has been shared yet, or the query is too narrow. Try broader terms, or ask Travisse which top-level page/teamspace to connect.
- **Don't confuse with `/notion-backlog`** — that skill writes to Travisse's personal Life Backlog database. This one writes to the Boostly workspace. Keep them separate.
- **Child pages are preserved on `update`** — the CLI skips `child_page` / `child_database` blocks when clearing body content, so nested docs aren't lost.
- **Never rebuild a page to change a few cells.** Deleting all blocks and re-appending destroys any edits Travisse made on the page and is slow (2026-09-02 incident). For toggle+table pages, PATCH the specific `table_row` block (`PATCH /v1/blocks/<row_id>` with `table_row.cells`) or the specific paragraph; build a name->row-id map by walking children first. Full-body `edit` is only for pages Travisse explicitly wants rewritten.
