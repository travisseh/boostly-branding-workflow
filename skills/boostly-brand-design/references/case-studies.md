# Case studies — real failures and their deterministic fixes

Each of these shipped to (or nearly shipped to) production before Travisse flagged it.
The pattern to internalize: diagnose at pixel level → encode as a harness gate/tool →
validate the gate fails the bad case and passes known-good → rerun only the flagged
location with a fresh subagent.

## 1. Paolo's — baked-in effects became a white halo (deglow lesson)

**Symptom:** shipped white knockout had a soft white emboss glow around every letter.
**Diagnosis:** the Wayback source PNG carried a baked-in white outer glow + offset black
drop shadow — 61% of its nonzero-alpha pixels were low-alpha effect fringe. `knockout`
recolors EVERY nonzero-alpha pixel white, so the effects became the halo. No existing
gate caught it: interior/stroke/holes all measure the opaque core. The subagent even
saw the glow and rationalized it as "reads as an intentional emboss."
**Fix:** `soft-fringe <img>` gate (softShare of nonzero-alpha > 0.30 = FAIL) +
`deglow <in> <out>` (keeps dark ink by luma x alpha smoothsteps, drops glow/shadow,
0.4px blur restores edge AA).
**Numbers:** bad file 0.612 FAIL → deglow → knockout output 0.031 ok, 16 clean counters
(the old file's "30 holes" included glow noise).
**Rule:** knockout recipe is restore-blocks → soft-fringe (deglow until pass) →
counter-punch → knockout → soft-fringe + holes on the OUTPUT.

## 2. River Grille — shipped a sharp-but-tiny mark (ship-gate lesson)

**Symptom:** logo visibly low-res on the card.
**Diagnosis:** best first-party source was 221px native. The agent knew the upscale rule
(sources < 500px) but shipped native anyway, writing "sized to stay crisp — do not scale
up further" out of distrust of the upscaler. Distrust of ESRGAN is not a reason to ship
small: a routine Real-ESRGAN 4x of the same cleaned asset was clean (crisp serifs,
smooth river gradient, 784x828).
**Fix:** `ship-gate <logo>` — final shipped file must be >= 700px longest side, hard gate.
"Do not scale up" notes are banned; if ESRGAN genuinely degrades the mark (eyeball a zoom
crop), ship best-available + flag `manual_review: low_res_source` so a human decides.
**Gate scoping learned here:** `soft-fringe` flags this color mark 0.419 — a FALSE
POSITIVE. It is a knockout-input gate; a color mark whose soft edges blend toward its
authored dark ground is invisible on a near-black card. Do not deglow marks that are not
being knocked out.

## 3. Mozzarella — pixelated wordmark with filled counters (upscale-order lesson)

**Symptom:** extracted wordmark pixelated; D/B/A counters filled solid.
**Diagnosis:** extracted from a 143px header (1px counters), binarized BEFORE ESRGAN
(destroying the antialiased signal the upscaler needs), shipped at 300px into a ~680px box.
**Fix/rule:** highest-res first-party source first → ESRGAN the antialiased band →
binarize at 4x → compose >= 700px. `holes` gate: the good asset has 9 counters, the bad
one 0.

## 4. Pariwaar / Fat Cat — stencil-blob knockouts (counter-punch lesson)

**Symptom:** knockouts with letter counters filled solid; colored elements left behind.
**Diagnosis:** baked-in near-white counters are opaque pixels, so a silhouette knockout
turns text into stencil blobs; and partial knockouts (white text + colored mascot) read
as mistakes.
**Fix:** `counter-punch` (converts near-white counters bounded mostly by ink into real
transparent holes) before knockout; FULL-means-FULL rule (knock out the entire lockup or
choose another treatment).

## 5. Downtown Joe's — silent mark substitution (never-silent lesson)

**Symptom:** card shipped with a DJ monogram nobody recognizes instead of the arched
wordmark.
**Diagnosis:** agent correctly rejected a blobby extraction, then silently fell back to
a lesser mark.
**Fix/rule:** mark-distinctiveness ladder (designed wordmark/lockup > distinctive emblem >
plain typeset > bare monogram) + HUNT WIDER for the same mark (FB/IG avatars via
graph.facebook.com/<page>/picture?type=large, GBP/Yelp photos, menu PDFs, og:image) +
`manual_review: mark_substitution` flag — substitution is never silent.

## 6. CLI logo upload silently no-op'd (multipart ordering, 2026-07-09)

Not a design failure but a write-path one: `branding set --logo-file` returned
success=true with colors written but logo_attachment_id null. Next's Node runtime decodes
multipart server actions with decodeReplyFromBusboy, which resolves `$B<id>` references
synchronously against parts ALREADY streamed — the CLI sent the root "0" JSON before the
file part. Fix (patched in boostly-links.ts): file part first, then the root model.
Reproduce/verify offline with the boostly repo's compiled react-server-dom-webpack
decoder under `node --conditions react-server`.

## 7. Small Town Tavern — clean source overprocessed before upscale (2026-07-13)

**Symptom:** two faint white ticks appeared above the black/gold lockup on the near-black
badge. The transparent PNG looked acceptable on a white viewer, so ordinary visual review
missed them.
**Diagnosis:** the official website PNG was already transparent and contained the complete
authored mark, including a white keyline around its silhouette. The pipeline nevertheless ran
background-removal cleanup, which stripped that intentional keyline and created two 21x1 opaque
near-white regions at the top edge. A 2x ESRGAN pass then made the altered edges crunchier and
amplified the remnants; a later resize preserved the damage. QA looked for fringe after the
transformation but never asked whether the transformation was warranted or diffed authored ink
against the source.
**Fix:** use the official PNG directly and make one alpha-safe deterministic resize to the final
target. Preserve the authored white keyline. Background removal, component cleanup, and AI
upscaling are unnecessary for this source.
**Rule:** classify before transforming. A verified first-party asset with functional transparency
and a complete mark takes the preservation path. Background removal is forbidden, and AI upscale
is not justified for a modest resize such as 500px to 800px. Any vanished border-ring keyline or
other authored ink is a hard stop, even when all alpha-fringe gates pass.

## 8. The Goldfinch — venue-photo yellow overruled authored website orange (2026-07-13)

**Symptom:** the card used mustard yellow `#dbb111`, while the website repeatedly used a strong
orange frame around its principal photography.
**Diagnosis:** Cloudflare blocked direct site inspection, so the proposal promoted a vibrant pole
from a namesake bird painting plus mustard stools and brass decor into the secondary brand token.
That was defensible fallback evidence, but it was environmental rather than authored. A later
reviewer screenshot exposed repeated authored website chrome; deterministic sampling measured the
frame at `#c05700`.
**Fix:** replace the photo-derived yellow with the website-authored orange, rerun text contrast and
the real proof renderer, and retain the old rationale in the revision audit. Prefer the exact sRGB
CSS/SVG token over screenshot pixels whenever the authenticated browser can expose it.
**Rule:** authored beats incidental. Evidence order is exact first-party CSS/SVG token > repeated
authored website UI chrome > repeated first-party collateral > logo palette > environmental or
photo sampling. Bot protection is a retrieval limitation, not permission to treat venue ambience
as the official palette.

## 9. Piloni's Restaurant — opaque counter residue survived every alpha gate (2026-07-13)

**Symptom:** the red `RESTAURANT` descriptor shipped with blotchy white/pink pixels inside its
letter counters, plus white cruft at the right edge. The flaws became obvious on the black card.
**Diagnosis:** the first-party JPG baked its white ground, keyline, JPEG ringing, and enclosed
counters into one opaque raster. `restore-blocks` preserved pixels that were enclosed or fused to
the intentional keyline; `border-dust` ignored large/fused and pink-tinted regions; `soft-fringe`
ignored fully opaque pixels; `holes` was not run because no global knockout occurred. ESRGAN then
amplified the surviving residue fourfold.
**Fix:** preserve the verified upper lockup, rebuild only the descriptor at native resolution from
strongly red glyph pixels, generate its white keyline only into exterior-connected negative space,
force enclosed counters transparent, and use a thin black outer stroke. Add minimal transparent
safety padding, resize deterministically, and inspect native/final/upload copies on black and light
mattes. The corrected asset has 3 native counter holes, 5 after antialiased resize, and passes
`border-dust` at all three sizes.
**Rule:** transparent-edge gates do not prove opaque negative space is clean. For JPG or opaque-
ground sources, counters and descriptor gaps get an explicit dual-matte native-resolution review
before upscale. Do not globally key white when authored white keylines or flag panels exist; scope
the reconstruction to the contaminated lockup element or hold `manual_review: tooling_gap`.
# Great Sage: deterministic palette, unreadable logo (2026-07-15)

- Failure: authored website greens were correctly selected for the card, but the full-color
  crimson/olive wordmark was applied on dark green. Its final-upload interior low-contrast share
  was 0.9138 even though other outer/mechanical checks passed.
- Why it shipped: the interior rule existed in documentation but was not a required plan receipt
  or an executor preflight. Fill-only auto-apply treated an empty branding target as sufficient.
- Correction: use the clean first-party alpha, preserve counters and silhouette, apply a complete
  white knockout, alpha-safe resize once to 800px, and keep the upload under 70 KB. The corrected
  final-upload interior share is 0.
- Permanent rule: hue is not contrast. Any final upload above 0.35 interior low-contrast share is
  blocked before production. A text-dominant mark must become a full knockout; an emblem that
  cannot tolerate knockout is held. No model confidence, source authority, fill-only status, or
  aggregate outer pass may override an inner gate failure.

# The Grill at River City: framework-default blue mistaken for brand color (2026-07-15)

- Failure: the card used bright Material UI blue `#1976D2` as its secondary band even though the
  website's authored footer/theme and reviewer screenshot use dark navy `#202233`.
- Why it shipped: the evidence extractor counted every six-digit hex in server-rendered HTML and
  ranked by raw frequency. Bundled MUI component CSS repeated its default blue 28 times, while the
  actual footer theme token appeared only 5 times. Fable reasonably trusted the misleading rank.
- Correction: replace web and print secondary colors with the exact authored `#202233`, rerender
  from production readback, and retain red `#D90429` plus the validated white knockout logo.
- Permanent rule: raw occurrence count is not brand authority. Explicit theme-role values and
  visible authored regions outrank framework CSS. Known framework defaults are flagged and cannot
  be selected without independent first-party corroboration.

# Leo's Superfood and Southlands Cafe: complete marks shipped on oversized canvases (2026-07-20)

- Failure: the correct first-party marks were selected, but each final upload retained a uniform
  outer canvas. Leo's kept roughly 4-7% blue padding per side; Southlands kept roughly 2-3.5%
  white padding. Product `object-fit: contain` then scaled the entire canvas, so the actual marks
  appeared unnecessarily small on both the tap card and link tree.
- Why it shipped: source-preservation permitted trimming transparent rows but did not measure
  opaque uniform backgrounds or require a final content-utilization receipt. Full-size proof
  review also hid the real badge-size penalty.
- Correction: detect a transparent or uniform-color border, compute the complete authored-mark
  bounds, extract only that rectangle plus at most 1.5% safety padding, then resize. Cropping is
  limited to uniform outer canvas and must preserve every border, keyline, glyph, icon, tagline,
  and shadow. Nonuniform borders are preserved for visual inspection rather than guessed.
- Permanent rule: every final upload runs `scripts/logo-crop.ts`. `excess_canvas_padding` blocks
  production. The historical Leo's and Southlands assets are regression failures; known-tight
  Towne Center Tavern and Mick's assets are regression passes.
