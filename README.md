# boostly-branding-workflow

Self-contained bootstrap package for the Boostly in-store branding and fulfillment workflow (tap
cards, stickers, signage): the Claude Code skills, agents, scripts, standing rules, and a macOS
installer, so a second operator's Mac can run the same pipeline without depending on Travisse's
machine. Point Claude Code at `docs/BOOTSTRAP.md` on a fresh Mac and it installs everything, then
walks the operator through storing their own credentials one at a time (never in chat).

Contents: `skills/` (copies of the pipeline skills with hardcoded paths replaced by config, see
`PATCHES.md`), `agents/` (fulfill-location, closeout-location, closeout-finish, discovery-transport),
`memory/RULES.md` (the operating rules), `setup/` (idempotent installer, `.env` template, Notion
wrapper shim, launchd job, review server), `tools/` (Apple Notes writer). Plan this package
implements: Boostly Notion "Karissa branding workflow handoff plan"
(https://www.notion.so/3edc831c671e817b8d1bca491532e031). Secrets never live in this repo.

Start here: [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).
