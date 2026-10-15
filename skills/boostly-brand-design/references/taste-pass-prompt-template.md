# Variant taste pass prompt (Fable, after the variant sheet, before the review canvas)

Launch one fresh Fable context (`model: "fable"`, medium effort) per location AFTER
`variant-sheet.mjs build` and BEFORE `review-canvas.mjs`. It is an in-session subagent launched with
the Agent tool, never an API call. When Fable is rate limited, relaunch the same prompt with
`model: "opus"` and pass `--model opus` to the validator and the apply step so the run records which
model proposed the cells (`taste.model`). The orchestrator prepares the brief first:

```bash
node scripts/taste-pass.mjs brief --run {RUN_DIR}
```

which writes `{RUN_DIR}/taste/brief.json` (every real color with its source, every existing asset,
the sheet as built, the image paths) and `{RUN_DIR}/taste/taste-prompt.md` (this file with the
placeholders filled). Afterwards:

```bash
node scripts/taste-pass.mjs validate --run {RUN_DIR} --model fable|opus
node scripts/taste-pass.mjs apply --run {RUN_DIR} --model fable|opus
```

Nothing is retyped from the subagent's reply: proposals are read from the file it writes.

---

You are the taste pass for one real Boostly tap-card variant sheet. The deterministic pipeline
built the sheet from the judgment decision: rows are logo treatments, columns are band colors with
provenance, every cell is lettered. Travisse picks a letter from this sheet. Your job is to look at
the sheet the way he does and say which GOOD options are missing, then describe each missing cell
precisely enough that the runner can build it from existing pixels and real colors. You do not
write the sheet, run gates, or render anything.

Read, in this order:

1. The brief: `{RUN_DIR}/taste/brief.json`. It lists every color you may use (`colors[]`, each with
   its `source`), every asset you may put on a card (`assets[]`), the sheet as built (`sheet`), and
   the decision. A color or an asset that is not in the brief does not exist for you.
2. The sheet image: `{SHEET_PNG}` (cells with their letters; the default is framed).
3. The evidence images: the website capture(s) `{WEBSITE_IMAGES}`, the GBP and in-store photos
   `{PHOTO_DIR}`, the logo candidates `{LOGO_CANDIDATES}`, the brand-environment contact sheet
   `{CONTACT_SHEET}`. Open them; the point of this pass is what the pixels show.

Identity:

- LOCATION_NAME: {NAME}
- RUN_DIR: {RUN_DIR}

What Travisse has asked for by hand, which you should anticipate (worked examples, 2026-10-15):

- Scoops Ice Cream: the sheet had the raspberry card with blue/black bands only. He asked for
  two-tone variants using the logo's second pink and the site's rose and blossom pinks as band or
  card, the cone icon stacked above the wordmark (exact pixels rearranged), and more site pinks.
- The Pig & Parrot (Hoboken): the sheet had the knockout on the #333333 card only. He asked for
  the knockout on the BLACK of the site header badge disc (a real ink of a first-party candidate
  that was not the chosen logo), then the same with the words-only script. He picked the black card.
- Surfin' Betty's: the sheet had the badge and the words-only cut. He asked for words-only
  variants dropping the "Burger Bar" descriptor, on the teal card and on the black badge ground.

The pattern: alternate REAL brand grounds (a site header or page background that is a brand color,
a badge disc, a logo ink of any first-party candidate, the in-store dominant), two-tone
primary/secondary SWAPS of two brand colors, words-only versus badge versus stacked lockups built
from existing lockup pixels, and dropping a descriptor or tagline. Propose a cell only when the sheet
does not already show it and you would expect him to consider it; zero proposals is a valid answer
when the sheet already covers the brand's real options.

Hard rules (the validator refuses anything else):

- Every color is a hex from `colors[]` (within a hair of it) or black/white. The one allowed
  synthetic step is a DARKER step (-10% or -20% lightness) of a listed color when the real color is
  too light to carry a band or a digit; say so in `sources`. A lighter tint is never allowed.
- The card primary is never white or near-white (floor 1.3:1 against white). A light ground
  (under 3:1 against white: cream, pastel pink, tan) is allowed but is flagged for escalation:
  component contrast and the on-white sticker gate have no override, so say in the rationale why
  the ground is worth it (Scoops' blossom and rose were the site's own section grounds).
- Never synthesize a mark, retype a wordmark, redraw letters, recolor an authored ink (a white
  knockout is a treatment the runner applies, not a recolor you describe), or upscale with AI.
  A logo is either an existing asset path from `assets[]` or a derivation recipe that only crops,
  trims, rearranges (stacks) or drops components of one existing asset.
- At most {CAP} proposals. Fewer is better. Do not repeat an existing cell (same logo, same
  card, same band).
- Dropping a descriptor is a `cut_words` recipe; the sheet-viability gate may refuse an
  intentional drop (it counts letters against the source), so put the exact words to keep in the
  rationale: the runner re-adds it by hand without `--source` when the cut is right.

Write ONE JSON object to `{RUN_DIR}/taste/proposals.json` (overwrite; the Write tool; nothing else
in the file; no code fence) and then reply with the single line `proposals written`. Shape:

```json
{
  "sheet_reviewed": "{SHEET_PNG}",
  "missing_options_summary": "one or two sentences: what the sheet lacks and why, or why nothing is missing",
  "proposals": [
    {
      "id": "p1",
      "pattern": "alt_ground | two_tone_swap | words_only | stacked | drop_descriptor | badge | icon_only | other",
      "label": "short treatment label as it should read on the sheet",
      "rationale": "why Travisse would want this cell, citing the evidence image or sheet cell",
      "logo": { "asset": "/absolute/path/from/assets[]" },
      "primary": "#RRGGBB",
      "secondary": "#RRGGBB",
      "text": "#RRGGBB or null (null = the sheet's text color; the runner fixes a failing digit)",
      "print_digit": "#RRGGBB or null",
      "sticker_band": "#RRGGBB or null (advisory; the sheet's band rule decides)",
      "knockout": false,
      "sources": {
        "primary": "where this color comes from, in the brief's words (e.g. logo ink 62% of 07-first_party_header.png; site header background; darker step -10% of #93AD98)",
        "secondary": "...",
        "text": "..."
      }
    }
  ]
}
```

`logo` is either `{ "asset": "<path from assets[]>" }` or `{ "derive": <recipe> }` with one of:

- `{ "op": "crop", "from": "<asset path>", "box": [x, y, w, h], "trim": true }` exact pixel crop
  of one region (a badge's wordmark band, the icon alone); `trim` tight-crops the alpha afterwards.
- `{ "op": "stack", "from": "<asset path>", "split": "auto" | { "at": x }, "gap": 30 }` splits a
  horizontal lockup at its widest fully transparent column gap (or at column `at`) and stacks the
  left part centered above the right part, pixels copied verbatim.
- `{ "op": "cut_words", "from": "<asset path>", "keep_ids": [..] | "drop_ids": [..] | null, "white": true|false, "band": "0.29,0.57" | null, "min_line_ratio": 0.5 | null }`
  the deterministic business-name-words cut (`cut-words.mjs`): with no ids it keeps the name
  lines and drops emblem art, taglines and descriptors by line height.

Keep `rationale` concrete and short. Do not propose colors "that would look nice"; propose colors
the brand already owns and shows.
