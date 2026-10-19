import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  BRAND_ENVIRONMENT_JUDGMENT_POLICY,
  buildBrandingEvidencePacket,
  extractAuthoredColorTokens,
  extractMetaThemeColor,
} from "./build-branding-evidence.ts";
import { validateFableDecision } from "./validate-fable-decision.ts";

const require = createRequire(new URL("../harness/package.json", import.meta.url));
const sharp = require("sharp");

test("branding packet deterministically ranks exact assets, extracts authored colors, and reuses only identical evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-brand-evidence-"));
  const logo = path.join(root, "human-logo.svg");
  const html = path.join(root, "site.html");
  const desktop = path.join(root, "desktop.svg");
  const mobile = path.join(root, "mobile.svg");
  const computedStyles = path.join(root, "computed-styles.json");
  fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="#C05700"/></svg>');
  fs.writeFileSync(html, '<style>:root{--brand:#C05700;--text:#FFFFFF}.button{background:#C05700}</style>');
  fs.copyFileSync(logo, desktop);
  fs.copyFileSync(logo, mobile);
  fs.writeFileSync(computedStyles, JSON.stringify({
    page_url: "https://example.com",
    surfaces: [
      { role: "primary_button", selector: ".button", viewport: "desktop", visible: true, background_color: "#C05700", text_color: "#FFFFFF" },
      { role: "primary_button", selector: ".button", viewport: "mobile", visible: true, background_color: "#C05700", text_color: "#FFFFFF" },
    ],
  }));
  const input = {
    location: { location_id: "loc_1", location_name: "Goldfinch", account_id: "acct_1", website_url: "https://example.com" },
    website_content_hash: "a".repeat(64),
    website_html_files: [html],
    website_visual_evidence: {
      status: "captured" as const,
      desktop_screenshot: desktop,
      mobile_screenshot: mobile,
      computed_styles_manifest: computedStyles,
    },
    logo_candidates: [
      { source: "Travisse attachment", provenance: "human_supplied" as const, path: logo },
      { source: "Website", provenance: "first_party_header" as const, path: logo },
    ],
    production_branding: { web_primary_color: "#000000" },
    feedback_case: { case_id: "brand_1", status: "revised" },
  };
  const first = await buildBrandingEvidencePacket(input, path.join(root, "first"), { harness: path.join(root, "missing-harness") });
  const logos = first.logo_candidates as Array<Record<string, unknown>>;
  assert.equal(logos.length, 1, "duplicate content hashes collapse to the highest-provenance candidate");
  assert.equal(logos[0].provenance, "human_supplied");
  assert.deepEqual(logos[0].measured_colors, [{ hex: "#C05700", pixel_share: 1 }]);
  assert.equal((first.reuse as Record<string, unknown>).eligible, false);
  assert.equal(((first.website as Record<string, unknown>).visual_evidence as Record<string, unknown>).status, "captured");
  assert.deepEqual(extractAuthoredColorTokens([html]).map((token) => [token.hex, token.count]), [["#C05700", 2], ["#FFFFFF", 1]]);

  const second = await buildBrandingEvidencePacket({
    ...input,
    prior_packet: first,
    prior_fable_judgment: { logo_choice: logos[0].local_path },
  }, path.join(root, "second"), { harness: path.join(root, "missing-harness") });
  assert.equal((second.reuse as Record<string, unknown>).eligible, true);

  const decision = {
    logo_choice: (second.logo_candidates as Array<Record<string, unknown>>)[0].local_path,
    palette: { web_primary_color: "#000000", web_secondary_color: "#C05700", web_text_color: "#FFFFFF" },
    composition: "Preserve the exact supplied mark",
    confidence: "high",
    flags: [],
    rationale: "Exact human-supplied asset and authored website colors agree.",
  };
  assert.deepEqual(validateFableDecision(second, decision), []);
  assert(validateFableDecision(second, { ...decision, production_write: true }).includes("unsupported_key:production_write"));
  assert(validateFableDecision(second, {
    ...decision,
    palette: { primary: "#000000", web_secondary_color: "#C05700", web_text_color: "#FFFFFF" },
  }).includes("unsupported_palette_role:primary"));
  assert(validateFableDecision(second, {
    ...decision,
    palette: { web_primary_color: "#000000", web_secondary_color: "#C05700" },
  }).includes("missing_palette_role:web_text_color"));
});

test("website-backed evidence fails closed without screenshots and computed visible surfaces", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-brand-visual-required-"));
  await assert.rejects(
    buildBrandingEvidencePacket({
      location: { location_id: "loc_1", location_name: "Example", account_id: "acct_1", website_url: "https://example.com" },
      website_content_hash: "b".repeat(64),
      logo_candidates: [],
      production_branding: {},
      feedback_case: null,
    }, path.join(root, "evidence"), { harness: path.join(root, "missing-harness") }),
    /website_visual_evidence is required/,
  );
});

test("authored color extraction demotes Material UI defaults below explicit site theme values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-brand-colors-"));
  const html = path.join(root, "site.html");
  fs.writeFileSync(html, [
    '<style>.mui-button{color:#1976D2}.mui-button:hover{background-color:#1565C0}</style>',
    '<script>window.siteTheme={"footerStyles":{"backgroundColor":"#202233"},"buttonStyles":{"buttonColor":"#D90429"}}</script>',
  ].join(""));

  const tokens = extractAuthoredColorTokens([html]);
  const navy = tokens.find((token) => token.hex === "#202233");
  const blue = tokens.find((token) => token.hex === "#1976D2");
  assert.equal(navy?.evidence_class, "theme_authored");
  assert.equal(blue?.evidence_class, "framework_default_risk");
  assert(tokens.indexOf(navy!) < tokens.indexOf(blue!), "explicit site theme color must outrank framework defaults");
});

test("brand environment evidence is copied into the packet, fingerprinted, and exact-place gated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-brand-environment-"));
  const image = path.join(root, "interior.svg");
  fs.writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#384A3A"/></svg>');
  const hash = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(image)).digest("hex");
  const manifest = path.join(root, "brand-environment.json");
  fs.writeFileSync(manifest, JSON.stringify({
    schema_version: 1,
    source: "searchapi_google_maps_photos",
    status: "available",
    place_identity: {
      requested_place_id: "place_123",
      returned_place_id: "place_123",
      exact_match: true,
    },
    minimum_evidence: { status: "satisfied" },
    flags: [],
    candidate_count: 1,
    selected_candidates: [{
      candidate_id: "searchapi-001",
      source_type: "searchapi_google_maps_photos",
      category: "Vibe",
      category_id: "CgIYIg",
      source_url: "https://images.example.test/interior.jpg",
      local_path: image,
      sha256: hash,
      perceptual_hash: "0000000000000000",
      duplicate_group: "duplicate-001",
      exact_identity_evidence: "Exact place_123",
      classification: "brand_environment",
      subtype: "interior_fixture",
      classification_source: "test",
      usable_for_brand_environment: true,
      rank_score: 120,
    }],
  }));
  const input = {
    location: {
      location_id: "loc_1",
      location_name: "Example Cafe",
      account_id: "acct_1",
      website_url: null,
      google_place_id: "place_123",
    },
    website_content_hash: "c".repeat(64),
    logo_candidates: [],
    brand_environment_manifest: manifest,
    production_branding: {},
    feedback_case: null,
  };
  const first = await buildBrandingEvidencePacket(input, path.join(root, "first"), { harness: path.join(root, "missing-harness") });
  const environment = first.brand_environment as Record<string, unknown>;
  assert.equal(environment.status, "available");
  assert.equal((environment.selected_candidates as unknown[]).length, 1);
  assert(fs.existsSync(environment.contact_sheet as string));
  const contactSheetMetadata = await sharp(environment.contact_sheet as string).metadata();
  assert.equal(contactSheetMetadata.height, 336, "environment contact sheet retains its label band");
  assert.deepEqual(environment.judgment_policy, BRAND_ENVIRONMENT_JUDGMENT_POLICY);
  assert.deepEqual(
    (environment.judgment_policy as typeof BRAND_ENVIRONMENT_JUDGMENT_POLICY).qualifying_corroboration
      .map((rule) => rule.minimum_perceptually_unique_images),
    [2, 1],
  );
  assert((environment.judgment_policy as typeof BRAND_ENVIRONMENT_JUDGMENT_POLICY).excluded_color_causes.includes("food_or_drink"));
  assert((environment.judgment_policy as typeof BRAND_ENVIRONMENT_JUDGMENT_POLICY).excluded_color_causes.includes("lighting_or_camera_color_cast"));
  assert.equal(first.schema_version, 4);

  const second = await buildBrandingEvidencePacket({
    ...input,
    prior_packet: first,
    prior_fable_judgment: { logo_choice: null },
  }, path.join(root, "second"), { harness: path.join(root, "missing-harness") });
  assert.equal((second.reuse as Record<string, unknown>).eligible, true);

  await assert.rejects(
    buildBrandingEvidencePacket({
      ...input,
      location: { ...input.location, google_place_id: "different_place" },
    }, path.join(root, "mismatch"), { harness: path.join(root, "missing-harness") }),
    /place ID does not match/,
  );
});

test("exact fetched GBP storefront candidates are exposed to Fable as brand environment evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-gbp-brand-environment-"));
  const storefront = path.join(root, "storefront.jpg");
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#222"/><rect x="180" y="140" width="540" height="180" fill="#990000"/></svg>'))
    .jpeg()
    .toFile(storefront);
  const manifest = path.join(root, "gbp-photos.json");
  fs.writeFileSync(manifest, JSON.stringify({
    place_id: "place_123",
    photos: [{ file: storefront }],
    brand_environment_candidates: [{
      local_path: storefront,
      classification: "permanent_exterior_sign",
      exact_location: true,
      corroboration: "Matches the independent first-party logo.",
    }],
  }));

  const packet = await buildBrandingEvidencePacket({
    location: {
      location_id: "loc_1",
      location_name: "Example Cafe",
      account_id: "acct_1",
      website_url: null,
      google_place_id: "place_123",
    },
    website_content_hash: "d".repeat(64),
    logo_candidates: [],
    gbp_manifest: manifest,
    production_branding: {},
    feedback_case: null,
  }, path.join(root, "evidence"), { harness: path.join(root, "missing-harness") });

  const environment = packet.brand_environment as Record<string, unknown>;
  assert.equal(environment.status, "available");
  assert.equal(environment.source, "google_places_selected_photos");
  assert.equal((environment.selected_candidates as Array<Record<string, unknown>>)[0].classification, "permanent_exterior_sign");
  assert.equal((environment.selected_candidates as Array<Record<string, unknown>>)[0].exact_location, true);
});

test("Spice Odyssey candidate evidence exposes sharpness and requires the low-sharpness flag", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-brand-sharpness-"));
  const sharpLogo = path.join(root, "spice-sharp-emblem.png");
  const blurryLogo = path.join(root, "spice-blurry-wordmark.png");
  await sharp(Buffer.from('<svg width="900" height="300"><rect width="900" height="300" fill="transparent"/><circle cx="150" cy="150" r="110" fill="#A10002"/><path d="M330 80 H830 V220 H330 Z" fill="#A10002"/></svg>'))
    .png()
    .toFile(sharpLogo);
  await sharp(sharpLogo).blur(12).png().toFile(blurryLogo);

  const packet = await buildBrandingEvidencePacket({
    location: { location_id: "loc_spice", location_name: "Spice Odyssey", account_id: "acct_spice", website_url: null },
    website_content_hash: "e".repeat(64),
    logo_candidates: [
      { source: "blurry first-party wordmark", provenance: "first_party_header", path: blurryLogo },
      { source: "sharp first-party spoon emblem", provenance: "first_party_header", path: sharpLogo },
    ],
    production_branding: {},
    feedback_case: null,
  }, path.join(root, "evidence"), { harness: path.join(root, "missing-harness") });
  const logos = packet.logo_candidates as Array<Record<string, unknown>>;
  const blurry = logos.find((candidate) => String(candidate.source).includes("blurry"))!;
  const crisp = logos.find((candidate) => String(candidate.source).includes("sharp"))!;
  assert(Number((crisp.sharpness as Record<string, unknown>).value) > Number((blurry.sharpness as Record<string, unknown>).value));
  assert.equal((blurry.sharpness as Record<string, unknown>).classification, "low");
  assert.deepEqual(
    Object.keys((packet.fable_contract as Record<string, unknown>).required_conditional_flags as Record<string, unknown>).sort(),
    ["low_sharpness_candidate", "mark_element_omitted"],
  );

  const decision = {
    logo_choice: blurry.local_path,
    palette: { web_primary_color: "#161616", web_secondary_color: "#A10002", web_text_color: "#FFFFFF" },
    composition: "Use the selected wordmark",
    confidence: "medium",
    flags: [],
    rationale: "Candidate is first party.",
  };
  assert(validateFableDecision(packet, decision).includes("missing_required_flag:low_sharpness_candidate"));
  assert(!validateFableDecision(packet, { ...decision, flags: ["low_sharpness_candidate"] })
    .includes("missing_required_flag:low_sharpness_candidate"));
});

test("unavailable SearchAPI receipts remain fail-open when the requested place ID matches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-brand-environment-unavailable-"));
  const manifest = path.join(root, "brand-environment.json");
  fs.writeFileSync(manifest, JSON.stringify({
    schema_version: 1,
    source: "searchapi_google_maps_photos",
    status: "unavailable",
    place_identity: {
      requested_place_id: "place_123",
      returned_place_id: null,
      exact_match: false,
    },
    flags: ["searchapi_identity_request_failed"],
    reason: "SearchAPI request failed",
    selected_candidates: [],
  }));
  const packet = await buildBrandingEvidencePacket({
    location: {
      location_id: "loc_1",
      location_name: "Example Cafe",
      account_id: "acct_1",
      website_url: null,
      google_place_id: "place_123",
    },
    website_content_hash: "d".repeat(64),
    logo_candidates: [],
    brand_environment_manifest: manifest,
    production_branding: {},
    feedback_case: null,
  }, path.join(root, "evidence"), { harness: path.join(root, "missing-harness") });
  assert.equal((packet.brand_environment as Record<string, unknown>).status, "unavailable");
  assert.deepEqual(
    (packet.brand_environment as Record<string, unknown>).judgment_policy,
    BRAND_ENVIRONMENT_JUDGMENT_POLICY,
  );
});

// 2026-09-21: gradient families (Coloradough) and the recorded source ladder
import { gradientFamilies } from "./build-branding-evidence.ts";
import { ladderRecord } from "./logo-sources.ts";

test("gradient families: a red gradient reports its share-weighted center, not the dark pole; flat inks report nothing", () => {
  const coloradough = [
    { hex: "#FFFFFF", pixel_share: 0.5 },
    { hex: "#AD1E30", pixel_share: 0.04 }, // dark pole (the site button)
    { hex: "#C51F27", pixel_share: 0.06 },
    { hex: "#D02020", pixel_share: 0.1 },  // center
    { hex: "#E23A3A", pixel_share: 0.05 },
    { hex: "#F06060", pixel_share: 0.03 }, // light pole
    { hex: "#247EBB", pixel_share: 0.2 },  // the blue, flat
  ];
  const families = gradientFamilies(coloradough);
  assert.equal(families.length, 1, JSON.stringify(families));
  assert.equal(families[0].center_hex, "#D02020");
  assert.equal(families[0].dark_pole, "#AD1E30");
  assert.equal(families[0].light_pole, "#F06060");
  assert.equal(families[0].buckets, 5);
  assert.deepEqual(gradientFamilies([{ hex: "#FFFFFF", pixel_share: 0.9 }, { hex: "#FB8308", pixel_share: 0.05 }, { hex: "#F37F0C", pixel_share: 0.02 }]), [], "two near-identical buckets are shading, not a gradient");
});

test("the packet records the source ladder as tried rungs with the best source and completeness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-brand-ladder-"));
  try {
    const logo = path.join(root, "logo.svg");
    fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="#C05700"/></svg>');
    const packet = await buildBrandingEvidencePacket({
      location: { location_id: "loc_1", location_name: "Skyboxx", account_id: "acct_1", website_url: null },
      website_content_hash: "b".repeat(64),
      logo_candidates: [{ source: "traced from the avatar", provenance: "first_party_other", path: logo, source_native_px: 640, derivation: "trace" }],
      logo_sources: [{ rung: "facebook_full", tried: true, width: 640, height: 394, url: "https://scontent/..." }, { rung: "site_png_original", tried: true, width: 230, height: 123 }],
      production_branding: {},
      feedback_case: null,
    }, path.join(root, "out"), { harness: path.join(root, "missing-harness.mjs") });
    const ladder = (packet.logo_sources as Record<string, unknown>).ladder as ReturnType<typeof ladderRecord>;
    assert.equal(ladder.best?.rung, "facebook_full");
    assert.equal(ladder.best?.longest_px, 640);
    assert.equal(ladder.complete_for_trace, false);
    assert.deepEqual(ladder.tried, ["site_png_original", "facebook_full"]);
    const candidate = (packet.logo_candidates as Array<Record<string, unknown>>)[0];
    assert.equal(candidate.source_native_px, 640);
    assert.equal(candidate.derivation, "trace");
    assert.ok(Array.isArray(candidate.gradient_families));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("meta theme-color: the first <meta name=\"theme-color\"> hex is recorded uppercase; attribute order and a missing tag are handled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-meta-theme-"));
  const a = path.join(root, "a.html"); const b = path.join(root, "b.html"); const none = path.join(root, "none.html");
  fs.writeFileSync(a, '<html><head><meta content="#db594b" name="theme-color"><meta name="theme-color" content="#111111"></head></html>');
  fs.writeFileSync(b, "<html><head><meta name='theme-color' content='rgb(1,2,3)'></head></html>");
  fs.writeFileSync(none, "<html><head><meta name=\"viewport\" content=\"#FFFFFF\"></head></html>");
  assert.equal(extractMetaThemeColor([none, a]), "#DB594B");
  assert.equal(extractMetaThemeColor([b]), null);
  assert.equal(extractMetaThemeColor([none]), null);
  assert.equal(extractMetaThemeColor([]), null);
});
