import assert from "node:assert/strict";
import test from "node:test";

import { contrastVsWhite, decisionMarks, emblemKnockoutCollapse, syntheticStep, validateFableDecision } from "./validate-fable-decision.ts";
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
  assert.equal(skyboxx.band_over_brand_ink?.mark_ink, "#FB8308");
  const cream = decisionMarks(packet({}, { measured_colors: [{ hex: "#8B2C1D", pixel_share: 0.5 }, { hex: "#E65F28", pixel_share: 0.08 }] }), decision({ web_primary_color: "#8B2C1D", web_secondary_color: "#E8E4DD" }));
  assert.equal(cream.band_over_brand_ink?.reason, "neutral_secondary");
  assert.equal(cream.band_over_brand_ink?.mark_ink, "#E65F28", "the ink near the primary is excluded by contrast; the orange earns the band");
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
