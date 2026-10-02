# Standing operating rules for the Boostly in-store branding workflow

Distilled from the lead session's memory (2026-09 to 2026-10). "Operator" is the person running the
pipeline on this machine; "Travisse" is the escalation point. Load this file into context before any
fulfill, pick, closeout, or finish. When a rule here conflicts with a convenience, the rule wins.

## Branding and logos
- Never retype a wordmark. Logos come from first-party source files, keyed cuts, or traces of a real
  mark. A re-typeset name in a system font is a defect; if one is found, rebuild it, do not ship it.
- The letter pick from the variant sheet is the go. Fable (the judgment subagent) proposes a default;
  a human picks the letter. The AI never picks for the human and never writes production before a pick.
- No white or near-white primary. No solid-silhouette knockout that fills authored negative space into a
  blob; prefer the open knockout that keeps the mark recognizable, and record the ink-retention hold as a
  human decision.
- Shipped logos are crisp: a source under 700 px gets the documented HQ rebuild (ladder first, trace
  only after the source ladder is exhausted). Resize first, then quantize inks and alpha; do not ESRGAN a
  blurry resize.
- Web/print split: when the pick's text color equals the band or disc (so the web issue digit would
  vanish), print keeps the pick exactly and web text goes white. Do it; do not ask.
- Light-ground picks: run `gates.ts check` on the card against the primary AND on the sticker against
  white BEFORE previews, cookies, or writes. component-contrast, primary-too-light, sticker-ground,
  ship-gate, and png-color-type have no pre-ship override; a refused override goes to Travisse.
- Gate text: pass `--expected "<the words on the asset>"` so text-legibility reads the right counters, and
  `--source <native candidate>` so ink-retention runs. `interior` (fill collision) is overridable with
  evidence; edge-quality verdicts `binary_alpha` and `stair_stepped` are never overridable: re-render.

## Review ritual
- At the variant-sheet stage build the review canvas (website shot, GBP photos with interior shots,
  logo image search, candidates with sources, the sheet with Fable's default marked, plain-language gate
  notes). The review page is the deliverable, never the sheet alone.
- Google image search is blocked for headless browsers. Use the live Chrome tab path in review-canvas.mjs
  or `--skip-google`; do not fight it.
- Signage previews and AI mockups are post-pick work (closeout), not review output.

## Closeout and finish
- Closeouts STOP after the Figma section is built. Show the Figma URL and a full-section screenshot;
  only after the reviewer approves the signage do Slack, branding complete, and Notion happen
  (closeout-finish agent).
- Exactly ONE Slack post per request, in the request's thread, and only when the request carries a
  thread ts. `post-review.mjs --apply` on an already-posted run overwrites the receipt; read
  `slack-post.json` first and never re-apply.
- Store details auto-confirm: at finish, when the ship-to on the request is complete (recipient, line1,
  city, state, zip), confirm store details in the same pass. An empty or partial ship-to is a routing
  item (who adds the address), never a question to the reviewer. Never invent an address.
- Live quantities: `request.quantities` in run.json is a snapshot. Read `fulfillment_items` live before
  `plan.mjs` and build to the live counts.
- Figma: the file key, template section, and slot grid come only from
  `boostly-signage-sheets/references/figma-target.json`. Take the next free slot from a LIVE scan
  (check x-range overlap, hand-moved sections block slots), never from a number in a prompt. Never touch
  another location's section. Over 16 tables: clone pages after logo, QR, and recopy; over about 21
  sheet slots use a second section in the next free slot.
- Figma image transport: logos and QR masters go in through `upload_assets` with a raw POST of the file
  bytes; the returned imageHash must equal the local SHA-1. Chunked base64 through `use_figma` is a last
  resort when `upload_assets` is missing, and never above about 40,000 base64 characters. Never resend a
  payload a safety classifier stopped. QR SVG masters import with a visible white frame fill: copy the
  holder child's fills onto the clone and delete the masters right away.
- Inherited branding (sibling location on account-scope branding): record `write.status` applied with
  `inherited: true`, copy the lead run's `variants/` before marking the same letter.
- Preflight call facts can be wrong in the direction of the rep's opening offer; read the transcript
  lines and correct the block before it reaches Slack.

## Production safety
- Production writes happen only after a pick, scoped to that one location: dry run, read the dry run,
  apply, read back. Cookie scope: `auth ensure-location` for branding and link writes (private scoped
  copy); the unscoped admin cookie for `fulfillment get`, `note`, `branding --complete`, `store-details`.
- Never share, print, echo, cat, log, paste, or commit a cookie, token, key, or env file. Cookie files are
  0600 in a 0700 temp dir and deleted at the end of the step.
- Link writes need `validate-discovery-report.mjs` exit 0 (fulfillment provider, Boostly.com profile).
  `action: "ready"` candidates are written at closeout without another look; `hold` waits for a human;
  a page that says it does not exist is a reject with its reason, not a hold.
- `boostly-links` exit 5 "server action ids rotated" after a deploy means nothing was written: rerun.

## Browser rules
- Browser work only through the Claude in Chrome extension tools, in the Boostly.com profile, in a tab
  the agent creates. Never AppleScript, `open <url>`, or anything that steals screen focus. Never re-open
  a URL whose verdict was already given. Never open new.boostly.com in a browser during discovery.
- No Chrome filter or CSP bypass: a `[BLOCKED: ...]` read, a refused extractor, a login wall, or a bot
  challenge means hold that candidate with the reason. No gzip/base64url re-encoding, no character
  swapping, no Blob script or nonce reuse. Plain chunk reads only.
- Browser captures of logged-in pages (Facebook, DoorDash) are normal evidence; keep them 0600 and never
  paste sidebar names into Slack or Notion. Do not spend time on "private data exposure" audits.

## Notion
- Spot updates only. Never delete-and-rebuild a page or re-append its blocks. Map entry -> field ->
  table_row block id and PATCH the specific row. Re-read the page immediately before the write; update an
  existing entry in place, append at the next free number otherwise.
- A page create that hangs after the body landed has already created the page: do not retry the create.

## Tooling habits
- Skills live in `~/.claude/skills` only. Edit with targeted patches, never restore a skill file from git
  HEAD (parallel agents hold uncommitted edits).
- `v2-db query --json --sql "<sql>"` (the positional form fails). `locations` has `status`, not
  `enabled`; `fulfillment_requests` has `canceled_at`, no `status`.
- `build-branding-evidence.ts`, `render-effective-proof.ts`, `gates.ts check --asset`, and
  `ai-mockup.mjs --phone` resolve paths from the cwd: run from the run dir or pass absolute paths.
- zsh: never name a loop variable `path`; `set -- $pair` does not word-split; avoid `echo =====`.
- `run-file set` schema: `write.receipts.*` are objects or null (paths go under `receipt_files`);
  `figma.shots` is an array or string.

## Escalation
- Escalate to Travisse: a refused gate override, an identity conflict, a logo that cannot be rebuilt
  crisp, a held link that needs a business decision, a ship-to gap nobody owns, a Figma slot conflict, or
  any production write outside the picked location. Everything else the operator decides.
- When the reviewer flags a defect in our output, start the fix that turn; a go is only needed for
  production writes, sends, and irreversible steps.
