# Per-Location Brand Design Subagent Brief

You are a fresh-context subagent producing one tapcard branding proof for:

- Location name: `{LOCATION_NAME}`
- Address: `{ADDRESS}`
- Location ID: `{LOCATION_ID}`
- Run directory: `{RUN_DIR}`

## Objective

Produce verified logo variants, a taste-passed two-color badge palette, a production-rendered tapcard proof screenshot, and a manifest under `{RUN_DIR}`. The target is similar-not-identical to the supplied gold values. Do not write to production systems.

## Hard Guardrails

- Write only inside `{RUN_DIR}` and this spike workspace.
- Do not write to `/Users/travisse/Programming/boostly`; it is read-only reference except the orchestrator may copy/remove the dev harness page.
- No production database writes, no Branding writes, no S3 uploads, no Slack.
- Keep credentials in env only. Never put secrets in artifacts.
- Similar-not-identical is the bar. Prefer a shippable brand match over exact hex mimicry.

## Pipeline

1. Resolve the location identity.
   - Find the official website and Google Business Profile for `{LOCATION_NAME}` at `{ADDRESS}`.
   - Record source URLs and evidence in the manifest.
   - If multiple locations or chains appear, confirm the address before using assets.

2. Acquire the logo.
   - Start with the official website and available GBP/source assets.
   - Resolution check: if the best logo has a long edge under 500px, run high-resolution image search for a transparent or clean logo.
   - Identity currency trumps resolution (v3 learning): the searched asset must be the SAME mark
     as the brand's CURRENT official-site identity — a higher-res but different/older mark (a
     legacy delivery-platform badge, a pre-rebrand logo) is NOT an acceptable substitute, no
     matter how much sharper it is. When the current mark only exists at low res, get fidelity
     from first-party sources instead: rasterize an SVG (favicons often embed the real vector),
     or wordmark-extract per the stroke-gate rule. If you must ship a mark that differs from the
     current site identity, flag `manual_review: identity_conflict`.
   - Confirm identity against the website before accepting any searched asset.
   - MARK SELECTION when a brand has several first-party marks (v1.3 — Wake & Take / Downtown
     Joe's lessons): prefer by brand distinctiveness — designed wordmark/lockup > distinctive
     emblem/avatar > plain typeset name > bare monogram/initials. (Gold chose the arched
     DOWNTOWN JOE'S wordmark over the DJ monogram, and the owl emblem over a plain Playfair
     typeset name.) A bare monogram or plain typeset fallback is a last resort.
   - MARK SUBSTITUTION IS NEVER SILENT (v1.3): if the brand's primary identity fails
     extraction/quality gates, first HUNT WIDER for another instance of the SAME mark —
     Facebook/Instagram avatars (graph.facebook.com/<page>/picture?type=large works), GBP and
     Yelp photos, menu PDFs, og:image, delivery platforms. If nothing shippable exists and you
     must fall back to a lesser mark (monogram, favicon, typeset name), flag
     `manual_review: mark_substitution` in the manifest so a human confirms the identity swap.
   - Upscaling (v4 learning + River Grille lesson): a soft, plain-resized raster on the card is
     UNACCEPTABLE, and so is a small-but-sharp one. MINIMUM SHIPPED RESOLUTION IS A HARD GATE:
     the logo file you ship must be >= 700px on its longest side. When the best source is below
     that (and no vector exists), use `harness/iterate-logo-rules.mjs upscale <in> <out> [scale]`
     (Real-ESRGAN via Replicate; token auto-resolved) with enough scale to clear the floor.
     NEVER ship a sub-700px mark with a "sized to stay crisp, do not scale up" note — that was
     the River Grille failure: the 221px mark shipped native and rendered visibly low-res on
     the card, while a routine ESRGAN 4x of the same cleaned asset was clean (crisp serifs,
     smooth gradients). ESRGAN color marks and photographic-gradient emblems too, not just
     wordmarks/knockouts; distrust of the upscaler is not a reason to ship small. If the ESRGAN
     result genuinely degrades the mark (halos, invented detail — eyeball a zoom crop), ship the
     best available anyway and flag `manual_review: low_res_source`.
     ORDER MATTERS: first produce a clean asset (background removed, bands extracted, recolored)
     from the best source at its native resolution, THEN ESRGAN the cleaned asset. Never ESRGAN
     an already-blurry plain resize — it sharpens the artifacts. Run the stroke gate on the
     native-resolution asset, not on an upscale (blur inflates the measured stroke width).
     TRANSPARENT-EDGE ORDER (Small Town Tavern lesson): before ESRGAN, run `border-dust` on
     the cleaned native asset. Small near-white border regions are a hard stop even if the logo
     looks clean on white; inspect on the intended primary and use `remove-border-dust`. After
     ESRGAN, run `restore-alpha <clean-source> <upscaled-candidate> <out>` because upscaler alpha
     is untrusted. For the production copy (1600px longest side — see the retina resolution rule below) use `resize-alpha`, never macOS `sips`, then
     rerun `border-dust` and inspect the actual dark/light card matte.
     OPAQUE NEGATIVE-SPACE ORDER (Piloni's lesson): `border-dust` passing does not prove a JPG
     extraction is clean. Before any upscale, render the native asset on both black and light
     mattes and inspect letter counters, descriptor gaps, and every outer edge for opaque white,
     pink JPEG ringing, or full-width light rows outside an authored panel. These pixels are fully
     opaque and may be fused to legitimate keylines, so alpha and pure-white component gates miss
     them. Never globally key white or run unscoped `counter-punch` on a full-color lockup. If the
     contamination is isolated to a descriptor band, rebuild only that band from its verified ink
     mask, generate keyline only into exterior-connected negative space, keep enclosed counters
     transparent, and rerun `holes`, `whiteblob`, and `border-dust`. A transparent safety margin
     may be at most 1.5% per edge to prevent antialias clipping; it is not presentation padding.
     Gate scoping note: `soft-fringe` is a KNOCKOUT-INPUT gate. A full-color mark headed for a
     card that matches its authored ground (e.g. dark mark edges on a near-black card) will
     "fail" it harmlessly — soft edges blending toward a matching ground are invisible. Do not
     deglow a color mark that is not being knocked out.
   - TIGHT-CROP GATE (Leo's Superfood / Southlands lesson): the upload is a content crop, not a
     layout canvas. Run
     `node --experimental-strip-types ~/.claude/skills/boostly-brand-design/scripts/logo-crop.ts --logo <final>`
     on the exact upload. A transparent, white, or uniform-color outer canvas may have at most
     1.5% removable padding on each side. If it fails, create the lossless tight crop with
     `--out <tight-logo.png>` before resizing, then rerun the gate. The helper may remove only
     uniform outer canvas and retains 1% safety padding by default; preserve every authored
     border, keyline, glyph, icon, tagline, and shadow. Never add square presentation padding to
     center a wide or tall mark because the product renderer owns centering. If the edge is
     nonuniform, do not guess a crop; `crop_unassessed_nonuniform_border` blocks unattended
     production until a human explicitly accepts the preserved asset after inspecting the
     badge-size proof.
   - Lockup simplification (batch-3/4 + eval-round learning) — MANDATORY MECHANICAL STEP, not
     a judgment call. On every multi-element lockup, run row-band analysis (per-row opaque-pixel
     counts → contiguous bands) AND `iterate-logo-rules.mjs components <logo>` (per-component
     area share, bbox, per-component stroke) on the cleaned mark, then classify:
     * CONTAINED TEXT STAYS (eval learning — overrides everything below): a descriptor/tagline
       that sits INSIDE or interlocked with a badge/crest/banner/mascot artwork is part of the
       mark — keep it. A "SMOKED GOODS" ribbon inside a vintage badge, a "MEXICAN GRILL & SEA
       FOOD" phrase nestled against the mascot: stripping these chops the logo up and leaves
       messy cuts. A band is strippable ONLY if it is free-standing and separable: its
       component(s) form their own connected components whose bboxes do not intersect any kept
       component's bbox, and removing them requires no cut through other ink.
     * Free-standing tagline/descriptor/address bands ("GRILL & BAR", "Food and Drinks Since
       1991", street addresses, "est." dates) → STRIP. Small secondary text almost always hurts
       the card.
     * Bands that fail a PER-BAND stroke test (`iterate-logo-rules.mjs stroke` on the band
       crop) → STRIP if separable; the global stroke test is NOT sufficient — chunky wordmark
       letters dominate the median and hide hairline bands (Texas Traditions: global 5px "ok"
       while the GRILL & BAR band measures 1px).
     * SMALL-ORNAMENT EXCEPTION (eval learning — MEASURE BEFORE DROPPING): a decorative
       component that is a small accent riding on a chunky wordmark (≲15-20% of ink area, and
       keeping it does not make the crop near-square) STAYS even when its strokes are hairline —
       human designers keep these (Pizzati's chef hat; Riwaaz's hairline mandala beside its
       wide wordmark). Run `components` and check the ornament's areaShareOfInk BEFORE invoking
       the dominant-thin/wordmark-extraction path — that path applies only when thin components
       are the BULK of the mark (largest component too-faint, or too-faint components >~40% of
       ink). Dropping a small ornament because it is hairline is a v1.2-era bug.
     * DESIGNED-DESCRIPTOR EXCEPTION (v1.3 — Riwaaz lesson): a short designed descriptor line
       (letter-spaced caps, <=~30 characters, no wider than the wordmark, sitting directly
       under/beside it in a wide lockup — "INDIAN CUISINE & BANQUET") is part of the composed
       lockup: KEEP it. The strip rule targets sentence-like sayings, est. dates, street
       addresses, and secondary text that squares the aspect or shrinks the brand name.
     * DOMINANT-THIN → WORDMARK (eval learning): when hairline/too-faint components form the
       bulk of the mark (the largest component fails the per-component stroke test, or
       too-faint components together exceed ~40% of ink area) and the lockup contains styled
       brand-name text, do the WORDMARK EXTRACTION — do not ship the emblem small (Mozzarella:
       hairline buffalo emblem + confetti dominate; gold ships the "Mozzarella DI BUFALA"
       wordmark large).
     * STRIP MECHANICS (eval learning): NEVER strip by row/column cropping — a component's rows
       can overlap kept letterforms (row-cropping the chef hat chopped the top of Pizzati's P).
       Remove with `iterate-logo-rules.mjs remove-components <in> <out> <id,...>` (mask-based;
       an element may span several component ids — remove all of them). Then re-run
       `components` and verify: no remnant fragments of the stripped element remain, and every
       kept component is unchanged. Any final crop must pass only through fully transparent
       rows/columns — never through ink.
     Record every stripped band/component in the manifest. Keep a tagline only when physically
     interlocked with wordmark artwork, and flag it.
     * OPAQUE-PANEL FAILURE ON FLAT LINE ART IS A TREATMENT STEP, NOT A HOLD (Ohya lesson,
       2026-08-11): when the only candidate is flat black/white or flat-color art on an opaque
       light ground and `validate-logo-surface` fails it, the sanctioned response is the normal
       treatment ladder — background removal (`restore-blocks` or `extract-family` on the ink
       family) then full `knockout` — exactly as for an interior-gate failure. Returning
       `logo_choice: null` / holding for a human because "the authored background may not be
       removed" is wrong for an opaque ground: preservation of canvas semantics protects
       AUTHORED transparency, not a scan-style opaque ground. Hold only photographic/shaded
       marks that cannot knockout.
     * AUTHORED BORDERS ARE PART OF THE MARK (Ohya lesson): when other first-party or physical
       usages of the mark show an enclosing border/keyline that the harvested asset lacks
       (web-crop variants often trim it), flag `mark_element_omitted` and prefer a source that
       includes it; a reviewer may direct a measured geometric completion (border drawn at the
       mark's own grid/keyline weight) — record it as reviewer_directed_border_completion.
     * CDN-RESIZED SOURCES (El Guapo lesson, 2026-08-11): a logo URL containing resize params
       (`cdn-cgi/image/width=300`, `?w=`, `_300x`, Popmenu/Cloudflare/Imgix patterns) is a
       THUMBNAIL of a larger original. Before accepting its resolution, refetch with the
       params raised/stripped (width=1920 or none) — El Guapo's 300px "header logo" was a
       907px asset behind a CDN resizer, and the difference was shippable vs unreadable.
     * PRODUCTION RESOLUTION TARGET IS 1600px, NOT 800px (Ohya/El Guapo retina lesson,
       2026-08-11): the badge logo box renders at ~680-760 DEVICE pixels on retina, so an
       800px upload sits at ~1:1 with zero headroom and any edge hardness shows as
       pixelation. Ship the production copy at 1600px longest side (2x headroom), produced
       by supersampling (Lanczos 2x above 1600, then down). The old <=800px convention is
       retired.
     * PRODUCTION BYTE BUDGET IS <=200KB (Travisse, 2026-08-18: Panzanellas 440KB flagged
       as too big). Always encode the exact final upload with max-effort lossless truecolor
       PNG (compressionLevel 9, adaptive filtering, effort 10 — the default encode left 43%
       on the table at identical pixels). If still over 200KB, step the longest side down in
       100px decrements — never below 1000px, never below the 700px ship-gate — rerunning
       the full battery at each step. Palette/indexed PNG and JPEG remain banned for
       meeting the budget.
     * DERIVATIVE-QUALITY SELF-CHECK (El Guapo corrected lesson, 2026-08-11 — reviewer
       rejection is the backstop, never the detector): after ANY extraction, knockout,
       recolor, or upscale, render a 2x zoom crop of the final next to the SAME region of
       the verified source, both on the actual card primary, and judge it as a designer
       would: jagged contours, speckled keylines, crumbed counters, or invented texture
       mean the derivative is UNSHIPPABLE even when every mechanical gate passes. Do not
       rationalize visible damage as "distressed style" — compare against the source's own
       edge quality. When the derivative cannot reach parity, fall back on your own to the
       best gate-passing treatment of the PRESERVED original (full lockup, flipped card
       ground, or hold) and state the tradeoff; shipping a degraded derivative for the
       reviewer to catch is a pipeline failure, and it happened twice on El Guapo before
       the preserved original shipped.
     * UPSCALE QUALITY (El Guapo pixelation lesson, 2026-08-11): never ESRGAN an
       extract-family output or any binarized-edge 2-tone asset — ESRGAN the CONTINUOUS
       full-color source FIRST, then extract at high resolution and Lanczos-downsample; the
       upscaler sharpens binarized hard edges into visible pixelation, and no mechanical gate currently catches it (open
       item: contour-roughness gate). For flat 2-tone marks, supersample with plain Lanczos
       (resize up >=2x over target, then down to final) and ALWAYS eyeball a 2x zoom crop of
       the final on the card primary before any write.
     * MULTI-COLOR FLAG/HERALDRY BACKGROUNDS (State Fare lesson, 2026-08-11): artwork that
       carries 3+ saturated-plus-neutral color families (a state flag, tartan, heraldic
       quarters) cannot survive ANY solid card primary — every candidate color erases one of
       its families (red card erased the Maryland flag's red panels, leaving broken white
       fragments). Do not hunt for a card color that saves it; extract the contained
       banner/wordmark element instead (State Fare's keylined white banner) and flag
       `mark_element_omitted`. Check this at proposal time by listing the artwork's color
       families against the proposed primary, not after a reviewer sees the bleed.
     * REVISION RUNS ARE NOT EXEMPT (Hooligan's lesson, 2026-08-11): a reviewer instruction
       like "preserve the original full-color logo" scopes the TREATMENT (no knockout, no
       recolor); it does not suspend lockup simplification or any contrast gate. Hooligan's
       shipped its free-standing "SPORTS BAR & GRILL" descriptor (per-band stroke 1.5px,
       separable) as near-black ink on a navy card at 1.79:1 — invisible. The strip rules and
       the per-component contrast gate below run on every proposal, including revisions and
       preservation-path assets.
     * "Interlocked" means the component bboxes intersect kept ink or removal would cut
       through other ink — measure it with `components`, never assert it from a glance.
       Hooligan's descriptor sat in its own components, 40px clear of the wordmark, and was
       still called "interlocked" in a rationale. If the bboxes do not intersect, it is
       free-standing.
   - Size/aspect rule (batch-4 learning): the wordmark should FILL the logo box. A stacked
     lockup (decoration over wordmark over tagline) is nearly square and renders small; after
     simplification prefer the crop that is wider than tall (~2:1 or wider when the wordmark
     allows) so the brand name reads large on the card.
   - Stroke-weight gate (batch-3 learning): run `harness/iterate-logo-rules.mjs stroke <logo>` on
     the variant you intend to render. If it reports `too-faint` (median stroke < 3px at render
     scale) or the mark is visibly overly detailed (hairline line-art emblems, engraving-style
     medallions), do NOT ship the full emblem — extract the brand WORDMARK instead: rasterize the
     highest-fidelity source (SVG if available) large, crop the wordmark text bands, drop scatter
     components, stack/center them, and use that at generous size. This is what human designers do
     with faint emblems. Re-run the stroke gate on the extraction to confirm it passes.
   - WORDMARK EXTRACTION RECIPE (v1.2 learning — a pixelated wordmark with filled-in letter
     counters is an automatic fail):
     * Source: extract from the HIGHEST-resolution first-party instance of the mark, not
       whichever asset you happened to clean first. Compare every downloaded asset — header
       logo, favicon.svg embedded rasters, apple-touch-icon, og:image, social avatars, delivery
       platform images. (A 143px header was used when a 260px favicon of the same mark existed;
       the difference is 1px counters vs 3px counters, which is the difference between garbage
       and shippable.)
     * Size floor: if the best wordmark band is under ~150px wide or its letter counters are
       ~1px at native, NO upscaler can recover it. Hunt for a bigger source; if none exists,
       flag `manual_review: low_res_wordmark` rather than shipping blobs.
     * Order for crisp-but-tiny sources: crop the band at native res → ESRGAN 4x the band
       (grayscale/antialiased input, NOT pre-binarized) → binarize/knockout at the UPSCALED
       resolution. Binarizing a tiny band first destroys counters and anti-aliasing that
       ESRGAN needs. (The clean-first rule still applies to its original target: never ESRGAN
       an already-degraded plain RESIZE.)
     * Crop bands so they contain ONLY the text — a sliver of an adjacent emblem arc caught in
       the band crop ships as a floating artifact. After composing, run `components` and remove
       any fragment that is not a letterform.
     * Ship size: the final wordmark asset must be >= 700px wide (the badge logo box renders at
       ~680 device px; anything smaller gets browser-blurred).
     * COUNTER-INTEGRITY GATE: run `harness/iterate-logo-rules.mjs holes <final>` — if the text
       contains counter letters (a, e, o, D, B, A, R, g, p...) and holes reports 0 or clearly
       fewer than the letterforms imply, the counters got filled somewhere; fix before
       rendering. Compare against `holes` on the source band when unsure.
       OPEN-BY-DESIGN COUNTERS (Hooligan's lesson): some display faces draw counters that
       connect to exterior negative space through channels between letterforms, so `holes`
       legitimately reports 0 with nothing filled. The requirement is SOURCE-RELATIVE, never
       absolute: pass `--source <verified-source>` to the `text-legibility` gate (or compare
       `holes` source-vs-final yourself) — holes must not DECREASE from the verified
       first-party/human-supplied source to the final. A generated or already-suspect asset
       may never serve as its own source (Nonna Vita failure mode). Also beware the converse
       artifact: a lockup can "pass" counter topology on holes contributed by an element you
       are about to strip (Hooligan's descriptor supplied all 11 holes); rerun topology on the
       exact post-strip final against the post-strip source.
       Note: `remove-components` also sweeps the removed components' antialias fringe
       (sub-ink alpha reachable from removed pixels) so ghost rows cannot stretch the crop or
       smudge the card; kept components' own antialiasing is untouched.
   - Compress each logo file to <= 1MB.
   - Save assets under `{RUN_DIR}/assets/`.

2b. Logo treatment rules (iteration-2/3 learnings — follow this order strictly).
   - Background removal: `harness/iterate-logo-rules.mjs restore-blocks <in> <out>` — border-connected
     flood fill that also restores background-colored pixels sandwiched between large solid color
     blocks on the same row (an Italian flag's white stripe). Never global color keying, and never
     bbox-based restore (it fills the gaps between script strokes with opaque white).
   - Vanishing elements: after choosing the primary, run
     `harness/iterate-logo-rules.mjs vanish-fix <in> <out> <primaryHex> <inkHex>` — any sizable color
     cluster with <1.5 contrast against the primary whose boundary mostly faces transparency will
     disappear on the card (an orange bread motif on an orange card). The tool recolors it to the
     ink color, matching how human designers handle it with mono renditions. Note in the manifest
     when this fires. ALWAYS run it (it is a no-op when nothing vanishes), and after the proof
     renders, eyeball it: wordmark text that reads faint on the card is a fail even if the pixel
     gates passed — recolor the text elements to ink and re-render.
   - Before synthesizing ANY variant, exhaust brand-published alternates: check every asset already
     downloaded (delivery-platform squares, favicons, social avatars) — brands usually publish both
     a dark and a light treatment, and the real one always beats a synthesized inversion.
   - Treatment preference order — try each and stop at the first that passes BOTH gates below:
     1. The original full-color mark, straight on the primary. This is what human designers
        ship most of the time; a contrasting outline/ring makes interior color overlap fine.
     2. A brand-published alternate variant (light or dark version from the brand's own site).
     3. White knockout via `iterate-logo-rules.mjs knockout` — for ANY flat vector-style mark
        (solid fills, line art — regardless of how many colors it has: a five-color flat family
        emblem knockouts perfectly) and for letterform lockups that fail the interior-fill gate
        (below). The ONLY exclusion is photographic/shaded raster art, which flattens into a
        blob. KNOCKOUT RECIPE (v1.3 + Paolo's deglow lesson):
        * background-remove first (`restore-blocks`), then run `soft-fringe` on the mark. A
          softShare > 0.30 means the PNG carries BAKED-IN EFFECTS (outer glow, drop shadow —
          exported into the file as a wide low-alpha band; clean antialiasing is only a 1-2px
          rim). `knockout` recolors EVERY nonzero-alpha pixel, so those effects become a smeared
          halo around the shipped mark (Paolo's: white glow + black drop shadow → white emboss).
          If it fails, run `deglow` (keeps dark ink by color x alpha, drops glow and shadow;
          dark-ink marks only — invert the luma ramp mentally for a light-ink source) and
          re-check until soft-fringe passes.
        * Then `counter-punch` (converts baked-in near-white letter counters and negative space
          into REAL transparent holes — skipping this ships stencil-blob text), then `knockout`.
        * After `knockout`, run `soft-fringe` on the OUTPUT too — it must pass. The interior,
          stroke, and holes gates all measure the opaque core and will NOT catch a halo.
        * FULL means FULL: knock out the ENTIRE lockup you ship. Never a hybrid (white wordmark
          + full-color mascot side by side reads as a mistake). If one element cannot be knocked
          out acceptably, drop that element per the lockup rules or choose another treatment —
          do not mix.
        * After ANY knockout that contains letterforms, run `holes` — 0 holes under counter
          letters (A, B, D, R, a, e, o...) = filled counters = fail, fix before rendering.
        * Preserve a verified first-party mark's authored color layers unless the selected
          treatment explicitly requires a knockout. A one-color conversion that merges a bright
          fill with its dark outline can retain the same silhouette while destroying letter
          anatomy. For a human-requested preservation revision where product-size OCR is blank for
          both good and rejected treatments, require the deterministic `authored-color-retention`
          gate to pass the final and fail the rejected treatment, plus render-legibility, counter
          topology, ink retention, and explicit native/product-size visual inspection.
     4. Synthesized inversion (dark disc → light disc) with a thin dark silhouette ring —
        acceptable but lossy; always flag `manual_review: synthesized_variant`.
     5. White medallion backing — LAST resort, and only AFTER documented knockout attempts of
        each lockup element (emblem alone, wordmark alone, both) with the reason each failed
        recorded in the manifest. ALWAYS flag `manual_review: medallion` (shipping a medallion
        without the flag is a contract violation), and never let it shrink the mark (padding
        <= 10% of mark size). A white box floating on the card is what the flag exists for.
   - INTERIOR-FILL GATE (eval learning — the edge gate alone is NOT sufficient): after choosing
     the primary, run `iterate-logo-rules.mjs interior <logo> <primaryHex>`. A letterform lockup
     whose keyline gives perfect edge legibility can still ship as outline-only or invisible
     letters when its FILL matches the card (red-fill wordmark with white keyline on a red card
     rendered as hollow outline text; red "TI" letters vanished on a red card). If the interior
     low-contrast share exceeds 0.35, block the unattended write. On a text-dominant mark, apply
     a FULL `knockout` of the
     whole lockup to white (or to ink on a light primary). Full means full: never recolor some
     letters and leave others colored, and never ship outline-only — the human designers knock
     the entire lockup out, accents included. If an emblem cannot tolerate a full knockout, hold
     it for human review; "brand-accurate" colors, an empty production target, model confidence,
     or an outer aggregate pass never overrides this final-upload gate. Rerun the gate on the exact
     final file against the actual card primary immediately before production.
   - PER-COMPONENT CONTRAST GATE (Hooligan's lesson, 2026-08-11 — the aggregate interior gate
     is NOT sufficient): run `iterate-logo-rules.mjs component-contrast <final> <primaryHex>`
     on the exact final upload against the actual card primary. Any component holding >= 0.5%
     of ink whose pixels are >= 90% low-contrast (< 3.0) against the primary is invisible on
     the card, and the gate exits 2. This catches what `interior` averages away: Hooligan's
     black descriptor was 100% at 1.79:1 on navy while the aggregate interior share read a
     passing 2.8% (black-on-navy also clears the 1.5 thresholds used by `interior` and
     `vanish-fix`, so neither fired). Fix by stripping the free-standing component or knocking
     out the FULL lockup — never by waiving the gate, and never by recoloring only that
     component while others keep their colors (recolor-to-white of a lone descriptor band is
     allowed ONLY as part of a documented full-knockout or when the reviewer explicitly asks
     for a white descriptor).
   - Fable-judgment corollary: when judging palette against a chosen logo, check EVERY ink
     family in `measured_colors` with >= 5% pixel share against the proposed primary and name
     the checked families in the rationale. "No interior-collision risk" is a claim about all
     ink families, not the dominant fill; Hooligan's rationale checked yellow (10.7:1) and
     never black (1.79:1). A dark secondary ink family on a dark primary (or light on light)
     must be flagged.
   - NO AD-HOC PIXEL SURGERY (eval learning — this caused 4 of 7 eval failures): background
     removal, recolors, knockouts, and component strips go ONLY through the harness commands
     (`restore-blocks`, `vanish-fix`, `knockout`, `remove-components`). Hand-rolled sharp/python
     keying scripts produced a black-filled script counter, a half-keyed interior splotch, and a
     chopped letterform. Letterform counters/holes must keep the source's own pixels (opaque
     white) or be fully transparent — never invented fill. If an operation you need has no
     harness tool, flag `manual_review: tooling_gap` instead of improvising.
   - POST-CLEAN CHECK (eval learning): run `iterate-logo-rules.mjs whiteblob <logo>` on the
     cleaned asset you intend to render. Any warning (opaque near-white region facing
     transparency = leftover background or half-keyed interior) must be investigated and fixed
     before the proof renders; interiors are all-or-nothing.
   - BORDER-DUST CHECK (Small Town Tavern lesson): run `border-dust` on every transparent
     cleaned native asset before upscale and on the final upload copy. Tiny border-connected
     near-white regions become obvious only on dark cards. Fix them with `remove-border-dust`,
     restore source alpha after AI upscale, and render the final proof on the actual primary.
   - OPAQUE-COUNTER CHECK (Piloni's lesson): for JPG/opaque-ground sources, inspect the native,
     final, and upload files on both dark and light mattes. Any white/pink residue in counters or
     negative space is a hard fail even when border-dust passes. Rebuild only the contaminated
     element from its verified ink mask or hold `manual_review: tooling_gap`; do not globally key
     authored white panels/keylines.
   - Ink density: on a light primary, prefer the variant with a light interior. A heavy solid
     dark disc on a cream card reads as a blob; the human-approved cards use light-interior
     marks with dark line art.
   - Size: the mark should fill the badge's logo box; never add padding around it.

3. Extract and choose colors.
   - SCREENSHOT-FIRST ROLE MAPPING (River City lesson): when an official website exists, inspect
     full-page desktop and mobile screenshots before assigning palette roles. Use visible,
     repeated semantic surfaces (header, footer, primary CTA, navigation, frames, page ground) to
     decide which colors actually lead the identity. Then use the computed style recorded for that
     exact visible element as the output hex. Screenshots determine relevance; computed styles
     determine precision. A color found only in unused/bundled CSS cannot become primary or
     secondary. Explain desktop/mobile disagreement; if it cannot be reconciled, flag
     `palette_not_visually_corroborated`.
   - Extract candidate palettes with `harness/iterate-logo-rules.mjs vibrant <logo>` (plus homepage
     and GBP photos for context). NEVER use cluster means or averaged samples — averaging blends in
     antialiased edges, shading, and gradient midpoints and always produces a duller color than the
     brand actually uses. The tool reports per-hue-bucket "vibrant poles" (median of the top-decile
     saturation×value pixels).
   - Authored values beat sampling only after visible corroboration: if the computed style of a
     screenshot-visible site surface or an SVG fill states the brand color exactly, use that value.
     Do not rank all colors in server-rendered HTML by occurrence count; common Material UI values
     such as `#1976D2`/`#1565C0` are framework defaults unless independently visible and branded.
   - DELIBERATE PHYSICAL BRAND CAN BEAT GENERIC CSS: a repeated screenshot-visible
     `theme_authored` website system remains authoritative, but corroborated exact-location
     signage or branded collateral may outrank `framework_default_risk` colors, CSS values absent
     from visible semantic surfaces, generic template chrome, or a single low-salience CTA.
     Physical evidence qualifies only when the same deliberate brand-owned sign, mark treatment,
     collateral treatment, or color family appears in at least two perceptually unique exact-place
     images, or when one exceptionally clear permanent exact-location sign agrees with an
     independent human-supplied/first-party asset or screenshot-visible `theme_authored` signal.
     Another GBP/SearchAPI image is not the independent first-party signal.
   - A qualifying permanent sign may justify a faithful simplified, full-white-knockout, or
     one-color treatment of the already verified first-party mark. It is treatment evidence, not
     permission to invent or substitute a logo. Never let it bypass the photographic/shaded-mark
     exclusions or any crop, edge, contrast, size, proof, or human-review gate.
   - Exclude color evidence caused by food or drink, lighting/camera casts, general decor or
     furniture, uniforms, seasonal items, one-off objects, third-party/vendor signage, delivery
     decals, neighboring tenants, or sibling brands. Photos choose treatment and color family or
     role, not a whole-scene sampled hex. Prefer an agreeing authored website token, logo pixel,
     SVG fill, or first-party collateral value for the exact hex. If no authored exact value
     exists, lower confidence and flag the measurement gap. If signage conflicts with the current
     first-party identity or appears stale, add `environment_sign_conflicts_current_identity`
     rather than elevating it.
   - INSTAGRAM EVIDENCE (Travisse, 2026-09-08, Park Avenue BBQ Grille): when a first-party
     Instagram exists (site social link, GBP, or V2 `instagram_url`), the runner reviews roughly
     the first 24 to 36 grid posts plus the profile picture and highlights covers in the logged-in
     Boostly.com Chrome profile and keeps only (a) posts showing the actual logo, (b) storefront
     and in-store photos with signage, walls, menus, uniforms, packaging, (c) branded flyers,
     menus, and templated posts repeating one color system across 3+ posts. Food-only photos,
     reposts, Canva graphics without the logo or the recurring system, holiday one-offs, and
     employee spotlights are ignored. It writes `{RUN_DIR}/evidence/instagram/instagram.md` (URL,
     posts reviewed, kept vs ignored, recurring colors with sampled hexes and post counts, logo
     variants seen, one-line verdict vs the website palette) plus 3 to 6 screenshots, and the
     manifest gets an `instagram` block or `instagram: not available (<reason>)`; never fabricate.
     Provenance: a color recurring on 3+ kept posts or in in-store photos is `instagram_recurring`,
     ranked ABOVE website computed styles (nav/footer backgrounds) and BELOW an authored logo ink
     or an explicit brand guideline. Park Avenue's computed nav was #222222 and the pipeline
     shipped black/yellow while the grid showed a dark green band on yellow on nearly every
     branded post and green in-store menus; the card was corrected to green/yellow. When Instagram
     and the website disagree on the primary, the variant sheet includes the Instagram primary as
     its own sheet (run `variant-sheet.mjs` once per primary and stitch) and `rationale` names
     both primaries and explains the choice; whenever `instagram_recurring` colors exist,
     `rationale` says whether they were used and why. Instagram hexes are sampled, never
     authored: snap to the nearest authored token when one is close. A logo variant seen only on
     Instagram enters as `instagram_profile` or `instagram_post`, same gates as every candidate,
     a lead for the authored file rather than a print-ready asset.
   - A bot challenge only means the fetcher could not inspect the site; it is not evidence that
     the website has no authored palette. Preserve the website visual-evidence receipt and explain
     any conflict between current site identity and physical signage.
   - When one color family spans several buckets (a gradient or shading), pick the MOST SATURATED
     pole with meaningful share (>= 3%) — human designers consistently choose the vivid pole, not
     the average or the pale end.
   - CONTRASTING-PAIR THRESHOLD (v1.2 tie-break): use a contrasting secondary ONLY when the
     second color family is a real co-lead of the brand: it holds >= 20% share of the mark's
     non-neutral ink (per `vibrant` shares) OR appears as an authored UI color in the site's
     CSS/theme tokens. A minor accent family below that (an Italian-flag green at 16% inside a
     red-led mark) does NOT earn the band — go monochrome instead. Human designers default to
     monochrome unless the brand is genuinely two-color.
   - If only one strong brand color exists (or the second family misses the threshold), use a
     monochrome pair: primary = brand color, secondary = a same-hue darker derivative from
     `harness/colors.mjs derive` — EXCEPT: if the mark itself carries a near-black/dark-neutral
     ink (black outlines, black lettering), prefer THAT as the secondary over a derived shade
     (v1.2 tie-break; matches how the human designers anchor red brands with black).
   - SECONDARY SHADE (v1.2): the vibrant-top-pole rule is for the PRIMARY. For the secondary
     band, prefer (a) an authored token value, then (b) a dark neutral present in the mark,
     then (c) the deeper/muted pole of the family — not the brightest pole. The secondary is an
     anchor, not a highlight.
   - Composition rule (batch-3 learning, corrected 2026-09-21 after That's a Wrap): when the brand
     carries a strong non-neutral color, that color IS the card primary — do not park it as an
     accent on a cream/neutral ground. When the mark is genuinely neutral line-art/ink with no
     strong brand chroma, the default is the DARK neutral: a black (or the mark's own near-black)
     card with a white knockout. The card primary is also the background of the digital touchpoint
     page, so WHITE OR NEAR-WHITE IS NEVER A PRIMARY (the validator rejects anything under 1.2:1
     against white; Travisse: "we can't do a primary color of white because then the linktree
     looks really bad"). Cream/tan cards remain a human call.
   - TEXT COLOR (v1.2 tie-break — deterministic): compute `harness/colors.mjs contrast` of
     both #ffffff and #000000 (or the mark's near-black) against the primary and pick the
     HIGHER ratio; on a near-tie (within 0.5) pick white. Do not choose by vibe — a saturated
     red primary takes black text (5.2 vs 4.0), which is what the human designers ship.
   - COMPOSITION FLAG: when the mark is genuinely neutral ink with no strong brand chroma, propose
     the black-card white-knockout orientation per the composition rule and ALWAYS flag
     `manual_review: neutral_mark_composition` so a human confirms it; never propose the white
     card.
   - BAND FROM THE MARK (Toscano's cream, Skyboxx tan, 2026-09-16/17): when the chosen mark carries
     a saturated non-text ink of at least 3% share that reads on the primary, that ink is the
     secondary, ahead of any site theme accent or neutral (cream, tan, gray), however small the
     ink is (Skyboxx's basketball at 5%). A site token may only win the band by an explicit
     argument in `rationale`; the validator marks `band_over_brand_ink` and the sheet moves the
     default to the mark-ink cell regardless.
   - GRADIENT INKS (Coloradough 2026-09-18): for a gradient family in the mark (`gradient_families`
     on the candidate), the band value is the family's `center_hex`, never the dark pole, and a
     site CTA that happens to match the pole does not stand in for the mark ink.
   - SOURCE SIZE IS A HOLD, NOT A FLAG (Nector, Big Potato, Skyboxx 2026-09-18/21): read
     `logo_sources.ladder` before choosing a traced or upscaled candidate. If `complete_for_trace`
     is false, do not choose it; say in `rationale` which rungs are untried. If the best source is
     under 700px the decision carries `traced_from_small_source` and the sheet holds the default.
   - Badge-number color: the issue-number circle is filled with the SECONDARY color and its digit
     uses textSecondary (falling back to text). If the secondary is dark and text is dark, the
     number vanishes — production has this bug live. Always pass an explicit
     `--text-secondary` to screenshot.mjs with >= 3.0 contrast against the secondary
     (usually `#ffffff` on a dark band).
   - Run `node harness/taste-check.mjs {RUN_DIR}/taste-config.json`. The logo gate is
     edge-band legibility: only the mark's silhouette boundary must contrast with the
     primary; interior fill matching the background is acceptable.
   - If it fails, iterate once on color selection and rerun. Keep both outputs or note the failed attempt in rationale.

4. Emit `{RUN_DIR}/manifest.json`.
   - Include:
     - `location_id`, `location_name`, `address`
     - `proposed.web_primary_color`
     - `proposed.web_secondary_color`
     - `proposed.web_text_color`
     - `proposed.print_primary_color`
     - `proposed.print_secondary_color`
     - `proposed.print_text_color`
     - `logo_files` with color/white variants and dimensions
     - `sources` with website, GBP, image, and palette source URLs
     - `taste_output`
     - `rationale`
   - Print colors should mirror web colors unless there is a concrete print-specific reason.

5. Render proof.
   - Run `node harness/screenshot.mjs --url-base <Boostly dev URL> --logo <chosen logo file> --primary <hex> --secondary <hex> --text <hex> --text-secondary <hex> --out {RUN_DIR}/proof.png`.
   - The screenshot must come from the Boostly app renderer via the dev harness page, not a composed image.

6. Compare to gold.
   - The orchestrator supplies the gold hexes.
   - Write `{RUN_DIR}/compare.md` with proposed vs gold hex values, CIEDE2000 deltaE values from `harness/colors.mjs deltae`, a same-logo assessment, and any miss classification.
   - Miss classifications: `wrong-logo`, `low-res`, `color-mismatch`, `taste-fail`, `harness-bug`.

## Output Contract

At the end, `{RUN_DIR}` must contain:

- `manifest.json`
- `compare.md`
- `proof.png`
- `assets/` with the selected logo variant(s)
- any small source notes needed to audit decisions

## DOM-RENDERED IDENTITY RULE (2026-08-21, Skyvibe)
The evidence packet's candidate pool must reflect the brand's dominant RENDERED identity, not only its uploaded asset files. When the site's primary mark is live HTML text (webfont hero or header wordmark), the runner captures it with harness/capture-dom-lockup.mjs and includes it as a first_party_other candidate. When judging, weigh "the mark the brand actually shows people" over "the file the brand uploaded" for tap-card recognition; if they conflict, say so explicitly and pick with reasoning. Precedent: Skyvibe shipped its uploaded cursive script while the site rendered an extended-sans hero wordmark; reviewer caught it; r3 switched to the DOM capture.
- BADGE PDF PROOF (2026-09-10): after any `branding set --apply`, run `~/.claude/skills/boostly-brand-design/scripts/render-badge-pdf.sh` on the readback and look at the badge PNG. The QR is drawn in print_text_color on print_primary_color (require >= 3:1) and react-pdf garbles palette PNGs with bit depth < 8; truecolor RGBA only.

## Wizard overwrite risk (2026-09-10)

Before any `branding set --apply`, check the account's onboarding sessions for a `branding` key in `account_settings_payload` on a session that is not completed. Completion and submit replay that guessed payload over the account base row as a full replace. Record `wizard_overwrite_risk: true` in the manifest and list the session id as an OPEN item; re-verify the row after any completion. Full rule in the brand-design SKILL.md under "Workflow: write to V2".
