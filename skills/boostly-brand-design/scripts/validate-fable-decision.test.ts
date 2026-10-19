import assert from "node:assert/strict";
import test from "node:test";

import { contrastVsWhite, contrastingAccent, darkGroundDefault, decisionMarks, emblemKnockoutCollapse, inkCandidateFor, sampledColors, syntheticStep, validateFableDecision } from "./validate-fable-decision.ts";
import { ladderRecord, loadLadder } from "./logo-sources.ts";

const CAND = "/run/evidence/logo-candidates/01.png";
function packet(overrides: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}) {
  return {
    logo_candidates: [{
      local_path: CAND,
      provenance: "first_party_header",
      width: 1600,
      height: 800,
      source: "Official site header logo",
      measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.9 }, { hex: "#FB8308", pixel_share: 0.05 }],
      sharpness: { value: 500, classification: "sharp" },
      ...candidate,
    }],
    ...overrides,
  };
}
function decision(palette: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { logo_choice: CAND, palette: { web_text_color: "#FFFFFF", ...palette }, composition: "c", confidence: "high", flags: [], rationale: "r", ...extra };
}

test("a valid six-key decision passes; white and near-white primaries are rejected under 1.3:1, authored tan passes (Q8 = A)", () => {
  assert.deepEqual(validateFableDecision(packet(), decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" })), []);
  const white = validateFableDecision(packet(), decision({ web_primary_color: "#FFFFFF", web_secondary_color: "#111111" }));
  assert.ok(white.some((e) => e.startsWith("primary_too_light:")), white.join("; "));
  const near = validateFableDecision(packet(), decision({ web_primary_color: "#F5F5F5", web_secondary_color: "#111111" }));
  assert.ok(near.some((e) => e.startsWith("primary_too_light:")));
  assert.ok(near.find((e) => e.startsWith("primary_too_light:"))?.includes("authored cream or tan card is fine"));
  assert.deepEqual(validateFableDecision(packet(), decision({ web_primary_color: "#D2B48C", web_secondary_color: "#8B2C1D", web_text_color: "#000000" })), [], "Chubby's-style tan card passes");
  assert.ok(validateFableDecision(packet(), decision({ web_primary_color: "#E8E4DD", web_secondary_color: "#8B2C1D" })).some((e) => e.startsWith("primary_too_light:")), "a 1.26:1 pale cream is near-white for a card");
  assert.ok(contrastVsWhite("#FFFFFF") < 1.01);
});

test("source ladder: a traced or upscaled logo_choice is refused until every rung over the floor was tried; native choices never are", () => {
  const traced = packet({}, { source: "PROVENANCE NOTE: potrace of the 640x394 Facebook avatar, rendered 1600x889", derivation: "trace", source_native_px: 640 });
  const errors = validateFableDecision(traced, decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" }));
  assert.equal(errors.length, 1, errors.join("; "));
  assert.ok(errors[0].startsWith("source_ladder_incomplete:"));
  assert.ok(errors[0].includes("instagram_profile_live"));

  const partial = packet({ logo_sources: { ladder: ladderRecord([{ rung: "facebook_full", tried: true, longest_px: 640 }]) } }, { derivation: "trace", source_native_px: 640 });
  const partialErrors = validateFableDecision(partial, decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" }));
  assert.ok(partialErrors[0]?.startsWith("source_ladder_incomplete:"));
  assert.ok(!partialErrors[0].includes("facebook_full"), "tried rungs are not listed as untried");

  const complete = packet({ logo_sources: { ladder: ladderRecord(loadLadder().rungs.map((r) => ({ rung: r.id, tried: true, longest_px: 640 }))) } }, { derivation: "trace", source_native_px: 640 });
  assert.deepEqual(validateFableDecision(complete, decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" })), []);
  const marks = decisionMarks(complete, decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" }));
  assert.equal(marks.traced_from_small_source, true);
  assert.equal(marks.source_native_longest_px, 640);
  assert.equal(marks.source_ladder?.complete_for_trace, true);

  // the same trace from an 896px Instagram render is not a small-source trace
  const big = packet({ logo_sources: { ladder: ladderRecord(loadLadder().rungs.map((r) => ({ rung: r.id, tried: true, longest_px: r.id === "instagram_profile_live" ? 896 : 640 }))) } }, { derivation: "trace", source_native_px: 896 });
  assert.equal(decisionMarks(big, decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" })).traced_from_small_source, false);
  // a native candidate with no ladder at all is fine
  assert.deepEqual(validateFableDecision(packet(), decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" })), []);
  assert.equal(decisionMarks(packet(), decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" })).traced_from_small_source, false);
});

test("band over brand ink (Skyboxx tan, Toscano cream): a neutral or non-mark secondary is marked when the mark carries a saturated ink >= 3% that clears 3:1 on the primary", () => {
  const skyboxx = decisionMarks(packet(), decision({ web_primary_color: "#161616", web_secondary_color: "#EFBA81" }));
  assert.equal(skyboxx.band_over_brand_ink?.reason, "secondary_not_a_mark_ink", JSON.stringify(skyboxx));
  assert.equal(skyboxx.band_over_brand_ink?.replacement.hex, "#FB8308");
  const cream = decisionMarks(packet({}, { measured_colors: [{ hex: "#8B2C1D", pixel_share: 0.5 }, { hex: "#E65F28", pixel_share: 0.08 }] }), decision({ web_primary_color: "#8B2C1D", web_secondary_color: "#E8E4DD" }));
  assert.equal(cream.band_over_brand_ink?.reason, "neutral_secondary");
  assert.equal(cream.band_over_brand_ink?.replacement.hex, "#E65F28", "the ink near the primary is excluded by contrast; the orange earns the band");
  const orange = decisionMarks(packet(), decision({ web_primary_color: "#161616", web_secondary_color: "#FB8308" }));
  assert.equal(orange.band_over_brand_ink, null, "a secondary that IS a mark ink is never marked");
  const tiny = decisionMarks(packet({}, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.98 }, { hex: "#FB8308", pixel_share: 0.02 }] }), decision({ web_primary_color: "#161616", web_secondary_color: "#EFBA81" }));
  assert.equal(tiny.band_over_brand_ink, null, "an ink under 3% is antialias, not a band candidate");
  const black = decisionMarks(packet({}, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.9 }, { hex: "#111111", pixel_share: 0.1 }] }), decision({ web_primary_color: "#C51230", web_secondary_color: "#000000" }));
  assert.equal(black.band_over_brand_ink, null, "a black band with only a black mark ink has nothing saturated to move to");
});

test("band_lighter_synthetic (Q3 = A): a lighter tint of a brand ink is rejected, a darker step is allowed and marked, a real ink and a near-black band are untouched", () => {
  // Fresho: the only real green is the site's tea-leaf sage #93AD98; C is the -20% step #5E7C64, accepted.
  const fresho = packet({ website: { authored_color_tokens: [{ hex: "#93AD98", evidence_class: "theme_authored", semantic_count: 3 }] } }, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.95 }] });
  const darker = decision({ web_primary_color: "#111111", web_secondary_color: "#5E7C64" });
  assert.deepEqual(validateFableDecision(fresho, darker), []);
  const darkMark = decisionMarks(fresho, darker).band_synthetic_step;
  assert.equal(darkMark?.direction, "darker", JSON.stringify(darkMark));
  assert.equal(darkMark?.of, "#93AD98");
  assert.equal(darkMark?.of_source, "site_token");
  const lighter = decision({ web_primary_color: "#111111", web_secondary_color: "#B9CBBD" });
  const errors = validateFableDecision(fresho, lighter);
  assert.ok(errors.some((e) => e.startsWith("band_lighter_synthetic:")), errors.join("; "));
  assert.ok(errors[0].includes("#93AD98"));
  // Coloradough AA: a +10% lighter step of the wordmark red #D02020 is rejected; the red itself is fine.
  const colo = packet({}, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.7 }, { hex: "#D02020", pixel_share: 0.2 }] });
  assert.ok(validateFableDecision(colo, decision({ web_primary_color: "#247EBB", web_secondary_color: "#DC4444" })).some((e) => e.startsWith("band_lighter_synthetic:")));
  assert.deepEqual(validateFableDecision(colo, decision({ web_primary_color: "#247EBB", web_secondary_color: "#D02020" })), []);
  assert.equal(syntheticStep(colo, decision({ web_primary_color: "#247EBB", web_secondary_color: "#D02020" }), "#D02020"), null, "the real ink is not a step");
  // That's a Wrap K: #1A1A1A over a black mark ink is a neutral depth, never flagged as a lighter tint.
  const wrap = packet({}, { measured_colors: [{ hex: "#111111", pixel_share: 0.9 }] });
  assert.deepEqual(validateFableDecision(wrap, decision({ web_primary_color: "#000000", web_secondary_color: "#1A1A1A" })), []);
  assert.equal(decisionMarks(wrap, decision({ web_primary_color: "#000000", web_secondary_color: "#1A1A1A" })).band_synthetic_step, null);
  // an unrelated hue is not a step of anything
  assert.equal(syntheticStep(colo, decision({ web_primary_color: "#247EBB", web_secondary_color: "#2ECC71" }), "#2ECC71"), null);
});

test("emblem_knockout_needs_words_default (Q7 = A): a collapsed emblem knockout needs words-only + mark_element_omitted, or an explained open knockout", () => {
  const katy = (candidate: Record<string, unknown>) => packet({}, { source: "White knockout of the mug-and-slice emblem lockup", treatment: "knockout", measured_colors: [{ hex: "#FFFFFF", pixel_share: 1 }], ...candidate });
  const blob = katy({ counter_topology: { verdict: "glyph_counters_filled" } });
  const bare = decision({ web_primary_color: "#C51230", web_secondary_color: "#000000" });
  const errors = validateFableDecision(blob, bare);
  assert.ok(errors.some((e) => e.startsWith("emblem_knockout_needs_words_default:")), errors.join("; "));
  assert.equal(emblemKnockoutCollapse(blob.logo_candidates[0] as Record<string, unknown>), "counter_topology:glyph_counters_filled");
  // words-only default: flag + the words say so
  const words = decision({ web_primary_color: "#C51230", web_secondary_color: "#000000" }, { flags: ["mark_element_omitted"], composition: "words-only 'Katy Pizza Kitchen' knockout on crimson; the full-color emblem stays on the sticker and POP" });
  assert.deepEqual(validateFableDecision(blob, words), []);
  // the flag alone, without a words-only direction, is not enough
  const flagOnly = decision({ web_primary_color: "#C51230", web_secondary_color: "#000000" }, { flags: ["mark_element_omitted"] });
  assert.ok(validateFableDecision(blob, flagOnly).some((e) => e.startsWith("emblem_knockout_needs_words_default:")));
  // Coloradough AD: an explained open knockout is the other accepted path
  const ridge = decision({ web_primary_color: "#247EBB", web_secondary_color: "#D02020" }, { rationale: "open knockout with the snow caps transparent (the window-decal look); the ridge stays recognizable" });
  assert.deepEqual(validateFableDecision(katy({ ink_retention: { verdict: "authored_white_dropped" } }), ridge), []);
  // interior blob evidence in mechanical_qa text also counts; a plain knockout without collapse evidence, or a full-color mark, never triggers
  const qa = katy({ mechanical_qa: { status: "complete", checks: { "ink-retention": { pass: false, summary: "verdict interior_blob: emblem interior edge density fell 71%" } } } });
  assert.ok(validateFableDecision(qa, bare).some((e) => e.startsWith("emblem_knockout_needs_words_default:")));
  assert.deepEqual(validateFableDecision(katy({}), bare), []);
  assert.deepEqual(validateFableDecision(packet({}, { source: "Full-color emblem lockup", counter_topology: { verdict: "glyph_counters_filled" } }), bare), []);
});

const DARK = { web_primary_color: "#161616", web_secondary_color: "#FB8308" };
function surfaces(...items: Array<{ role: string; background_color: string; viewport?: string; visible?: boolean }>) {
  return { visual_evidence: { status: "captured", computed_styles: { surfaces: items.map((s) => ({ selector: s.role, text_color: "#FFFFFF", viewport: "desktop", visible: true, ...s })) } } };
}

test("dark_ground_default: a single BRIGHT ink, a light badge, black site chrome, a badge disc and a neutral-ink mark each trigger; a deep ink, a black outline or a dark-only sibling do not; the ground is authored dark first, plain black last; the band is the brand chroma", () => {
  // Pagliai's-style single red ink on transparency: nothing authored dark, so the card is plain black with the red band
  const single = decisionMarks(packet({}, { measured_colors: [{ hex: "#C51230", pixel_share: 0.85 }, { hex: "#FFFFFF", pixel_share: 0.1 }] }), decision({ web_primary_color: "#C51230", web_secondary_color: "#FFFFFF" }));
  assert.deepEqual(single.dark_ground_default, { ground: "#000000", ground_source: "default_black", band: "#C51230", band_source: "mark_ink", reasons: ["single_bright_ink"] });
  // Senor: a single navy ink (10.3:1 on white) already is a dark card; nothing fires
  assert.equal(darkGroundDefault(packet(), { measured_colors: [{ hex: "#143C8C", pixel_share: 0.94 }, { hex: "#FFFFFF", pixel_share: 0.06 }] }), null);
  // Dino's: the chosen card logo is a white knockout (no ink); the inks come from the full-color sibling of the same provenance
  const dinos = packet({ logo_candidates: [
    { local_path: CAND, provenance: "first_party_header", measured_colors: [{ hex: "#FFFFFF", pixel_share: 1 }], rank_score: 90 },
    { local_path: "/run/evidence/logo-candidates/08.jpg", provenance: "social", measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.9 }, { hex: "#1565C0", pixel_share: 0.1 }], rank_score: 100 },
    { local_path: "/run/evidence/logo-candidates/01.png", provenance: "first_party_header", measured_colors: [{ hex: "#FF1717", pixel_share: 0.55 }, { hex: "#FF1818", pixel_share: 0.45 }], rank_score: 80 },
  ] });
  assert.equal(inkCandidateFor(dinos, dinos.logo_candidates[0] as Record<string, unknown>).local_path, "/run/evidence/logo-candidates/01.png");
  const dinosMark = decisionMarks(dinos, decision({ web_primary_color: "#FF1717", web_secondary_color: "#BD131A" })).dark_ground_default;
  assert.equal(dinosMark?.ground, "#000000"); assert.equal(dinosMark?.band, "#FF1717");
  assert.deepEqual(dinosMark?.reasons, ["single_bright_ink"]);
  // Creamer: the chosen knockout's same-provenance sibling is a 98% dark-green derivative; the saturated sibling carries the inks
  const creamer = packet({ logo_candidates: [
    { local_path: CAND, provenance: "first_party_header", measured_colors: [{ hex: "#FFFFFF", pixel_share: 1 }], rank_score: 90 },
    { local_path: "/run/evidence/logo-candidates/04.png", provenance: "first_party_header", measured_colors: [{ hex: "#0B1F0D", pixel_share: 0.98 }, { hex: "#FFFFFF", pixel_share: 0.02 }], rank_score: 95 },
    { local_path: "/run/evidence/logo-candidates/01.png", provenance: "gbp", measured_colors: [{ hex: "#33993F", pixel_share: 0.3 }, { hex: "#F7A8C4", pixel_share: 0.3 }, { hex: "#FFFFFF", pixel_share: 0.4 }], rank_score: 80 },
  ] });
  assert.equal(inkCandidateFor(creamer, creamer.logo_candidates[0] as Record<string, unknown>).local_path, "/run/evidence/logo-candidates/01.png");
  assert.equal(darkGroundDefault(creamer, creamer.logo_candidates[0] as Record<string, unknown>), null, "two balanced inks on a light badge is no dark card");
  // Pig & Parrot: a black roundel header badge with no chroma anywhere on the site; the decision's teal is the last-resort band
  const pig = packet({ logo_candidates: [
    { local_path: CAND, provenance: "gbp", measured_colors: [{ hex: "#FFFFFF", pixel_share: 1 }] },
    { local_path: "/run/evidence/logo-candidates/07.png", provenance: "first_party_header", measured_colors: [{ hex: "#000000", pixel_share: 0.62 }, { hex: "#FEFEFE", pixel_share: 0.18 }] },
  ] });
  const pigMark = decisionMarks(pig, decision({ web_primary_color: "#333333", web_secondary_color: "#42C0D2" })).dark_ground_default;
  assert.equal(pigMark?.ground_source, "badge_disc"); assert.equal(pigMark?.band, "#42C0D2"); assert.equal(pigMark?.band_source, "decision_secondary");
  assert.equal(decisionMarks(pig, decision({ web_primary_color: "#333333", web_secondary_color: "#000000" })).dark_ground_default, null, "a black secondary is no band");
  // Pig & Parrot: a black badge disc carrying 55% of the mark is the ground; the teal is the band
  const disc = darkGroundDefault(packet(), { measured_colors: [{ hex: "#0A0A0A", pixel_share: 0.55 }, { hex: "#2AA198", pixel_share: 0.3 }, { hex: "#FFFFFF", pixel_share: 0.1 }] });
  assert.equal(disc?.ground, "#0A0A0A"); assert.equal(disc?.ground_source, "badge_disc"); assert.equal(disc?.band, "#2AA198");
  assert.deepEqual(disc?.reasons, ["badge_disc"]);
  // Franks: a white badge with one red ink is a light badge; the site header black is the authored ground
  const franks = darkGroundDefault(packet({ website: surfaces({ role: "header", background_color: "#111111" }, { role: "footer", background_color: "#FFFFFF" }) }), { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.6 }, { hex: "#D02020", pixel_share: 0.35 }] });
  assert.equal(franks?.ground, "#111111"); assert.equal(franks?.ground_source, "site_header"); assert.equal(franks?.band, "#D02020");
  assert.deepEqual(franks?.reasons, ["light_badge", "site_header_black"]);
  // the logo's own 12% dark ink outranks the site footer black as the ground
  const own = darkGroundDefault(packet({ website: surfaces({ role: "footer", background_color: "#0B0B0B" }) }), { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.5 }, { hex: "#1A1A1A", pixel_share: 0.12 }, { hex: "#2E7D32", pixel_share: 0.2 }, { hex: "#F9A825", pixel_share: 0.18 }] });
  assert.equal(own?.ground, "#1A1A1A"); assert.equal(own?.ground_source, "logo_dark_ink"); assert.equal(own?.band, "#2E7D32", "the larger saturated ink is the band");
  assert.deepEqual(own?.reasons, ["site_footer_black"], "the mark's own dark ink is a ground source, never a trigger");
  // Scoops: a 14% black outline in a full-color illustration on a light site is not a dark field
  assert.equal(darkGroundDefault(packet(), { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.4 }, { hex: "#B24570", pixel_share: 0.25 }, { hex: "#F9A825", pixel_share: 0.21 }, { hex: "#010101", pixel_share: 0.14 }] }), null);
  // Julia's: a one-ink near-black mark is a neutral-ink mark with its own black as the ground; a black disc with white only is a disc
  const julias = packet({ website: surfaces({ role: "primary_cta", background_color: "#B24570" }) }, { measured_colors: [{ hex: "#080B0B", pixel_share: 0.97 }, { hex: "#FFFFFF", pixel_share: 0.03 }] });
  const neutral = darkGroundDefault(julias, julias.logo_candidates[0] as Record<string, unknown>);
  assert.deepEqual(neutral?.reasons, ["neutral_ink_mark"]); assert.equal(neutral?.ground, "#080B0B"); assert.equal(neutral?.ground_source, "logo_dark_ink");
  // a dark-only sibling never earns the disc for a chosen that has a saturated sibling (Creamer above); a 45% black with 55% gray is no disc either
  const gray = packet({}, { measured_colors: [{ hex: "#101010", pixel_share: 0.45 }, { hex: "#5D5D5D", pixel_share: 0.55 }] });
  assert.equal(darkGroundDefault(gray, gray.logo_candidates[0] as Record<string, unknown>), null);
  // footer alone, mobile-only surfaces still count, a hidden surface does not
  const footer = darkGroundDefault(packet({ website: surfaces({ role: "footer", background_color: "#0B0B0B", viewport: "mobile" }, { role: "header", background_color: "#000000", visible: false }) }), { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.7 }, { hex: "#FB8308", pixel_share: 0.1 }, { hex: "#1565C0", pixel_share: 0.1 }] });
  assert.equal(footer?.ground_source, "site_footer"); assert.equal(footer?.ground, "#0B0B0B"); assert.deepEqual(footer?.reasons, ["site_footer_black"]);
  // two balanced saturated inks on a light site, no dark anywhere: no trigger
  assert.equal(darkGroundDefault(packet({ website: surfaces({ role: "header", background_color: "#FFFFFF" }) }), { measured_colors: [{ hex: "#FB8308", pixel_share: 0.45 }, { hex: "#1565C0", pixel_share: 0.45 }] }), null);
  // a neutral-only mark on black chrome has no brand chroma for the band unless the site CTA supplies one
  const outline = { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.9 }, { hex: "#111111", pixel_share: 0.1 }] };
  const noChroma = packet({ website: surfaces({ role: "header", background_color: "#000000" }) }, outline);
  assert.equal(darkGroundDefault(noChroma, noChroma.logo_candidates[0] as Record<string, unknown>), null);
  const withCta = packet({ website: surfaces({ role: "header", background_color: "#000000" }, { role: "primary_cta", background_color: "#B24570" }) }, outline);
  const cta = darkGroundDefault(withCta, withCta.logo_candidates[0] as Record<string, unknown>);
  assert.equal(cta?.band, "#B24570"); assert.equal(cta?.band_source, "site_cta");
});

test("band_over_brand_ink (rule 4): a tint of the primary, a sub-3% logo ink and the theme-color meta token yield to a contrasting accent; the replacement ranks hue contrast first, then mark ink, site CTA, second site chroma, in-store sample", () => {
  // Senor-style: secondary is a lighter tint of the primary red, also a mark ink; the green mark ink contrasts
  const tint = decisionMarks(packet({}, { measured_colors: [{ hex: "#8B1A1A", pixel_share: 0.5 }, { hex: "#C04040", pixel_share: 0.2 }, { hex: "#2E7D32", pixel_share: 0.15 }] }), decision({ web_primary_color: "#8B1A1A", web_secondary_color: "#C04040" }));
  assert.equal(tint.band_over_brand_ink?.reason, "same_hue_secondary", JSON.stringify(tint.band_over_brand_ink));
  assert.deepEqual(tint.band_over_brand_ink?.replacement, { hex: "#2E7D32", source: "mark_ink", share: 0.15 });
  // same-hue secondary with no contrasting color anywhere: the mark stays null (a same-hue swap is pointless)
  assert.equal(decisionMarks(packet({}, { measured_colors: [{ hex: "#8B1A1A", pixel_share: 0.6 }, { hex: "#C04040", pixel_share: 0.3 }] }), decision({ web_primary_color: "#8B1A1A", web_secondary_color: "#C04040" })).band_over_brand_ink, null);
  // a 2% logo ink is antialias; the 20% blue is the band
  const low = decisionMarks(packet({}, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.7 }, { hex: "#1565C0", pixel_share: 0.2 }, { hex: "#F9A825", pixel_share: 0.02 }] }), decision({ web_primary_color: "#161616", web_secondary_color: "#F9A825" }));
  assert.equal(low.band_over_brand_ink?.reason, "low_share_ink"); assert.equal(low.band_over_brand_ink?.replacement.hex, "#1565C0");
  // the theme-color meta token (site header mustard) is a mark ink at 8% but still yields to the site CTA when the CTA contrasts
  const metaPacket = packet({ website: { meta_theme_color: "#E2A838", authored_color_tokens: [], ...surfaces({ role: "primary_cta", background_color: "#1E6F5C" }) } }, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.8 }, { hex: "#E2A838", pixel_share: 0.08 }] });
  const meta = decisionMarks(metaPacket, decision({ web_primary_color: "#161616", web_secondary_color: "#E2A838" }));
  assert.equal(meta.band_over_brand_ink?.reason, "meta_theme_token");
  assert.deepEqual(meta.band_over_brand_ink?.replacement, { hex: "#1E6F5C", source: "site_cta", share: null }, "no second mark ink, so the CTA is the accent");
  // ranking: a same-hue mark ink loses to a hue-contrasting CTA; without a CTA the second site chroma, then the in-store sample
  const inks = [{ hex: "#C04040", share: 0.2 }];
  assert.equal(contrastingAccent(packet({ website: surfaces({ role: "primary_cta", background_color: "#1E6F5C" }) }), inks, "#8B1A1A", null)?.source, "site_cta");
  const tokens = [{ hex: "#2A6EBB", evidence_class: "theme_authored", semantic_count: 2 }, { hex: "#999999", evidence_class: "theme_authored", semantic_count: 9 }, { hex: "#00D084", evidence_class: "theme_authored", semantic_count: 4 }];
  assert.deepEqual(contrastingAccent(packet({ website: { authored_color_tokens: tokens, ...surfaces({ role: "footer", background_color: "#2A6EBB" }) } }), inks, "#8B1A1A", null), { hex: "#2A6EBB", source: "site_second_chroma", share: null }, "a gray token is never an accent; the blue is seen on the footer");
  assert.equal(contrastingAccent(packet({ website: { authored_color_tokens: tokens } }), inks, "#8B1A1A", null)?.source, "mark_ink", "a token on no visible surface (WordPress preset green) is not an accent");
  const store = packet({ brand_environment: { selected_candidates: [{ measured_colors: [{ hex: "#2AA198", pixel_share: 0.3 }, { hex: "#888888", pixel_share: 0.5 }] }] } });
  assert.deepEqual(contrastingAccent(store, inks, "#8B1A1A", null), { hex: "#2AA198", source: "instore", share: 0.3 });
  assert.deepEqual(contrastingAccent(packet(), inks, "#8B1A1A", null), { hex: "#C04040", source: "mark_ink", share: 0.2 }, "with nothing contrasting, the saturated mark ink still beats a neutral");
  assert.equal(contrastingAccent(packet(), inks, "#8B1A1A", null, { requireHueContrast: true }), null);
  // the Toscano/Skyboxx behavior is unchanged
  const skyboxx = decisionMarks(packet(), decision({ web_primary_color: "#161616", web_secondary_color: "#EFBA81" })).band_over_brand_ink;
  assert.equal(skyboxx?.replacement.share, 0.05); assert.equal(skyboxx?.replacement.source, "mark_ink");
});

test("band_lighter_synthetic exemption (rule 8): a lifted step of a SAMPLED color passes and is marked of_source sampled; the same lift of a mark ink or site token is still refused", () => {
  // Koshari: the store's teal #2AA198 sampled from the selected brand_environment photos; the +10% lift is a pick
  const store = packet({ brand_environment: { selected_candidates: [{ measured_colors: [{ hex: "#2AA198", pixel_share: 0.3 }] }, { measured_colors: [{ hex: "#2AA198", pixel_share: 0.1 }, { hex: "#F8F8F8", pixel_share: 0.4 }] }] } }, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.95 }] });
  assert.deepEqual(sampledColors(store), [{ hex: "#2AA198", share: 0.2, source: "instore" }], "a near-white sample is not a color; shares average across photos");
  const lifted = decision({ web_primary_color: "#161616", web_secondary_color: "#32BBAF" });
  assert.deepEqual(validateFableDecision(store, lifted), []);
  const mark = decisionMarks(store, lifted).band_synthetic_step;
  assert.equal(mark?.direction, "lighter"); assert.equal(mark?.of_source, "sampled"); assert.equal(mark?.of, "#2AA198");
  // the sheet's own sampled list (instore, instagram_recurring, sampled, second_chroma_*) is honored; an unknown source is not
  const listed = packet({ sampled_colors: [{ hex: "#2AA198", source: "instagram_recurring", share: 0.4 }] }, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.95 }] });
  assert.deepEqual(validateFableDecision(listed, lifted), []);
  const unknown = packet({ sampled_colors: [{ hex: "#2AA198", source: "fable_guess" }] }, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.95 }] });
  assert.deepEqual(validateFableDecision(unknown, lifted), [], "an unrelated hue with no known base is not a step of anything");
  assert.equal(syntheticStep(unknown, lifted, "#32BBAF"), null);
  // the same lift of an authored token stays banned (Coloradough AA)
  const token = packet({ website: { authored_color_tokens: [{ hex: "#2AA198", evidence_class: "theme_authored", semantic_count: 3 }] } }, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.95 }] });
  assert.ok(validateFableDecision(token, lifted).some((e) => e.startsWith("band_lighter_synthetic:")));
  // when the same hex is both an authored token and a sample, the authored reading wins (the lift is still a tint of a real token)
  const both = packet({ website: { authored_color_tokens: [{ hex: "#2AA198", evidence_class: "theme_authored", semantic_count: 3 }] }, sampled_colors: [{ hex: "#2AA198", source: "instore" }] }, { measured_colors: [{ hex: "#FFFFFF", pixel_share: 0.95 }] });
  assert.ok(validateFableDecision(both, lifted).some((e) => e.startsWith("band_lighter_synthetic:")));
});

test("emblem knockout (rule 3): a full-color composition on a dark ground is the second accepted path; full color on a light card is not", () => {
  const blob = packet({}, { source: "White knockout of the mug-and-slice emblem lockup", treatment: "knockout", measured_colors: [{ hex: "#FFFFFF", pixel_share: 1 }], counter_topology: { verdict: "glyph_counters_filled" } });
  const fullDark = decision({ web_primary_color: "#161616", web_secondary_color: "#C51230" }, { composition: "full-color authored emblem lockup on the black card, nothing stripped" });
  assert.deepEqual(validateFableDecision(blob, fullDark), []);
  const fullLight = decision({ web_primary_color: "#C51230", web_secondary_color: "#000000" }, { composition: "full color emblem on crimson" });
  assert.ok(validateFableDecision(blob, fullLight).some((e) => e.startsWith("emblem_knockout_needs_words_default:")));
  assert.ok(validateFableDecision(blob, fullLight).find((e) => e.startsWith("emblem_knockout_needs_words_default:"))?.includes("full-color authored mark on a dark ground"));
});
