import { createHash } from "node:crypto";

import type { StageMetric } from "./stage-metrics.ts";

export const PLAN_SCHEMA_VERSION = 1;
export const CUSTOM_LINK_PRESENTATION = {
  ordering: { title: "Order Online", display_title: "Order Online", description: "Order your favorites", button_text: "Order Now" },
  careers_jobs: { title: "Careers", display_title: "Join Our Team", description: "Grow with our team", button_text: "Apply Now" },
  menu: { title: "Menu", display_title: "Menu", description: "See what's cooking", button_text: "View Menu" },
  catering: { title: "Catering", display_title: "Catering", description: "Food for your gathering", button_text: "View Options" },
  events: { title: "Events", display_title: "Events", description: "See what's happening", button_text: "View Events" },
  reservations: { title: "Reservations", display_title: "Reservations", description: "Save your table", button_text: "Reserve Now" },
} as const;
export const CAREERS_DISPLAY_TITLE = CUSTOM_LINK_PRESENTATION.careers_jobs.display_title;
export const CAREERS_BUTTON_TEXT = CUSTOM_LINK_PRESENTATION.careers_jobs.button_text;

const AUTO_WRITE_CATEGORIES = new Set([
  "ordering",
  "order",
  "menu",
  "events",
  "reservations",
  "careers_jobs",
  "catering",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "x_twitter",
]);
const REVIEW_ONLY_CATEGORIES = new Set([
  "gift_cards",
  "loyalty_rewards",
  "ios_app",
  "android_app",
  "app_downloads",
]);
const QUERY_IDENTITY_CATEGORIES = new Set([
  "menu",
  "careers_jobs",
  "catering",
  "events",
  "order",
  "ordering",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "x_twitter",
  "reservations",
  ...REVIEW_ONLY_CATEGORIES,
]);
const VALID_WRITE_KINDS = new Set<WriteOperation["kind"]>([
  "social",
  "branding",
  "location",
  "touchpoint",
  "linktree_defaults",
]);
const VALID_LINK_ACTIONS = new Set<LinkDecision["action"]>([
  "write",
  "hold",
  "preserve",
  "not_found",
]);
const VALID_LINK_TARGETS = new Set<LinkDecision["target"]>([
  "location",
  "branding",
  "touchpoint",
  "none",
]);
const VALID_MODEL_EXCEPTION_KINDS = new Set<ModelExceptionKind>([
  "ambiguous_business_identity",
  "conflicting_candidate_tie",
  "unstructured_event_timing",
  "multiple_plausible_logos",
  "palette_or_composition",
  "branding_quality_gate_failure",
]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);
const BRANDING_PALETTE_ROLES = new Set([
  "web_primary_color",
  "web_secondary_color",
  "web_text_color",
  "print_primary_color",
  "print_secondary_color",
  "print_text_color",
  "print_text_secondary_color",
]);
const REQUIRED_WEB_PALETTE_ROLES = [
  "web_primary_color",
  "web_secondary_color",
  "web_text_color",
];
const MAX_LOGO_UPLOAD_BYTES = 70_000;
const MAX_INTERIOR_LOW_CONTRAST_SHARE = 0.35;

type JsonObject = Record<string, unknown>;

type FinalAssetQa = {
  ship_gate_pass: boolean;
  border_dust_pass: boolean;
  soft_fringe_pass: boolean;
  source_preservation_pass: boolean;
  interior_low_contrast_share: number;
  upload_bytes: number;
};

type EffectiveBrandingQa = {
  proof_path: string;
  proof_validation_pass: boolean;
  logo_surface_pass: boolean;
  logo_surface_verdict: "ok" | "opaque_light_panel_on_colored_surface";
};

type WebsiteVisualQa = {
  status: "captured" | "unavailable";
  desktop_screenshot?: string;
  mobile_screenshot?: string;
  computed_styles_manifest?: string;
  palette_correspondence_pass: boolean;
  reason?: string;
};

export type ModelExceptionKind =
  | "ambiguous_business_identity"
  | "conflicting_candidate_tie"
  | "unstructured_event_timing"
  | "multiple_plausible_logos"
  | "palette_or_composition"
  | "branding_quality_gate_failure";

export type ModelException = {
  kind: ModelExceptionKind;
  model: "luna" | "sol" | "fable";
  reason: string;
  evidence_refs: string[];
  category?: string;
};

export type LinkDecision = {
  category: string;
  url: string | null;
  action: "write" | "hold" | "preserve" | "not_found";
  reason: string;
  target: "location" | "branding" | "touchpoint" | "none";
  presentation?: { title: string; display_title: string; description: string; button_text: string };
  verification?: JsonObject;
};

export type WriteOperation = {
  sequence: number;
  kind: "social" | "branding" | "location" | "touchpoint" | "linktree_defaults";
  scope: "account" | "location";
  category?: string;
  url?: string;
  quantity?: number;
  idempotency_key: string;
  fill_only: boolean;
  requires_readback: true;
  payload?: JsonObject;
};

export type FulfillmentPlan = {
  schema_version: 1;
  write_policy?: "links_only";
  plan_id: string;
  generated_at: string;
  dry_run_default: true;
  request: {
    request_key: string;
    canonical_thread_ts: string;
    fulfillment_request_id?: string;
    badge_quantity: number | null;
    badge_quantity_status: "valid" | "missing" | "invalid" | "conflict";
  };
  location: {
    location_id: string;
    location_name: string;
    account_id: string;
    account_name: string;
    website_url: string | null;
    is_general: false;
    branding_scope: "account" | "location";
  };
  links: LinkDecision[];
  writes: WriteOperation[];
  branding: {
    status: "reuse" | "needs_fable" | "apply" | "hold";
    evidence_packet?: string;
    evidence_fingerprint?: string;
    confidence?: "low" | "medium" | "high";
    flags: string[];
    rationale?: string;
    final_logo_path?: string;
    final_asset_qa?: FinalAssetQa;
    effective_branding_qa?: EffectiveBrandingQa;
    website_visual_qa?: WebsiteVisualQa;
    fable_decision_path?: string;
    fable_decision_sha256?: string;
    fable_output?: {
      logo_choice: string | null;
      palette: Record<string, string>;
      composition: string;
      confidence: "low" | "medium" | "high";
      flags: string[];
      rationale: string;
    };
  };
  badges: {
    action: "create" | "hold" | "none";
    quantity: number | null;
    reason: string;
  };
  model_exceptions: ModelException[];
  required_outputs: ["audit", "state", "notion_checklist", "slack_summary"];
  metrics: StageMetric[];
};

export type PlanInput = {
  write_policy?: "links_only";
  safety_holds?: Array<{ category: string; url: string; reason: string }>;
  request: FulfillmentPlan["request"];
  location: FulfillmentPlan["location"];
  discovery_report: JsonObject;
  branding?: FulfillmentPlan["branding"];
  model_exceptions?: ModelException[];
  metrics?: StageMetric[];
};

export function buildFulfillmentPlan(input: PlanInput): FulfillmentPlan {
  const links = applyModelExceptionHolds(
    buildLinkDecisions(input.discovery_report),
    input.model_exceptions ?? [],
  );
  for (const hold of input.safety_holds ?? []) {
    if (!hold.category || !hold.url || !hold.reason) throw new Error("Incomplete safety hold");
    for (const link of links) {
      if (link.category === hold.category && canonicalLinkUrl(link.url, link.category) === canonicalLinkUrl(hold.url, hold.category)) {
        link.action = "hold";
        link.target = "none";
        link.reason = hold.reason;
      }
    }
  }
  if (input.write_policy === "links_only") {
    if (input.branding?.status === "apply") throw new Error("Branding writes are outside links-only scope");
    for (const link of links) {
      if (link.action === "write" && (link.category === "reservations" || (link.target === "branding" && !["facebook", "instagram", "x_twitter", "tiktok", "youtube"].includes(link.category)))) {
        link.action = "hold";
        link.target = "none";
        link.reason = link.category === "reservations"
          ? "category_requires_human_review"
          : "category_requires_human_review";
      }
    }
  }
  const writes = buildWrites(input, links);
  const badges = badgeDecision(input.request);

  const identity = `${input.request.canonical_thread_ts}|${input.request.request_key}|${input.location.location_id}`;
  const plan: FulfillmentPlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    ...(input.write_policy ? { write_policy: input.write_policy } : {}),
    plan_id: `fulfillment_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
    generated_at: new Date().toISOString(),
    dry_run_default: true,
    request: input.request,
    location: input.location,
    links,
    writes,
    branding: input.branding ?? { status: "needs_fable", flags: [] },
    badges,
    model_exceptions: input.model_exceptions ?? [],
    required_outputs: ["audit", "state", "notion_checklist", "slack_summary"],
    metrics: input.metrics ?? [],
  };
  const errors = validateFulfillmentPlan(plan);
  if (errors.length) throw new Error(`Invalid fulfillment plan: ${errors.join("; ")}`);
  return plan;
}

export function parseFulfillmentPlan(value: unknown): FulfillmentPlan {
  const shapeErrors = validatePlanShape(value);
  if (shapeErrors.length) throw new Error(`Invalid fulfillment plan shape: ${shapeErrors.join("; ")}`);
  const plan = value as FulfillmentPlan;
  const errors = validateFulfillmentPlan(plan);
  if (errors.length) throw new Error(`Invalid fulfillment plan: ${errors.join("; ")}`);
  return plan;
}

export function buildLinkDecisions(discoveryReport: JsonObject): LinkDecision[] {
  const results = asArray(discoveryReport.category_results);
  const proposals = [
    ...asArray(discoveryReport.proposed_location_updates),
    ...asArray(discoveryReport.proposed_touchpoint_events),
  ].map(asObject);
  const manual = asArray(discoveryReport.manual_review_items).map(asObject);
  const decisions: LinkDecision[] = [];

  for (const rawResult of results) {
    const result = asObject(rawResult);
    const category = stringValue(result.category);
    if (!category) continue;
    const selected = asObject(result.selected_link);
    const existing = asObject(result.existing_link);
    const status = stringValue(result.category_status) ?? "not_found";
    const url = canonicalLinkUrl(candidateUrl(selected) ?? candidateUrl(existing), category);
    const matchingProposal = proposals.find((proposal) =>
      stringValue(proposal.field_name) === locationField(category) ||
      stringValue(proposal.touchpoint_category) === category,
    );
    const hold = manual.find((item) => stringValue(item.category) === category);

    if (status === "existing_verified") {
      decisions.push({ category, url, action: "preserve", reason: "existing_verified", target: "none" });
      continue;
    }
    if (!matchingProposal) {
      // Older discovery reports mislabeled verified search socials as rejected.
      // Preserve their evidence for review only; never synthesize a write proposal.
      const verifiedSocialWithoutProposal = status === "found_rejected" &&
        ["facebook", "instagram", "tiktok", "youtube", "x_twitter"].includes(category) &&
        selected.status === "verified" && selected.liveness === "live" && selected.relevance === "match";
      const holdReason = stringValue(hold?.reason) ?? (verifiedSocialWithoutProposal
        ? "Social profile matches the business, but lacks an approved write proposal. Confirm brand ownership before saving."
        : null);
      const action = holdReason || status.includes("review") ? "hold" : "not_found";
      decisions.push({
        category,
        url,
        action,
        reason: holdReason ?? status,
        target: "none",
        verification: selected,
      });
      continue;
    }

    const proposal = matchingProposal;
    const verification = asObject(proposal.verification);
    const writeGate = asObject(proposal.write_gate);
    const proposedUrl = canonicalLinkUrl(
      stringValue(proposal.proposed_value) ?? stringValue(proposal.url) ?? url,
      category,
    );
    const gateFailure = deterministicGateFailure(category, verification, writeGate);
    if (gateFailure) {
      decisions.push({
        category,
        url: proposedUrl,
        action: "hold",
        reason: gateFailure,
        target: "none",
        verification,
      });
      continue;
    }

    const target = stringValue(proposal.field_name)?.startsWith("branding.")
      ? "branding"
      : stringValue(proposal.field_name)?.startsWith("locations.")
        ? "location"
        : "touchpoint";
    const presentation = target === "touchpoint" ? presentationForCategory(category) : null;
    decisions.push({
      category,
      url: proposedUrl,
      action: "write",
      reason: "deterministic_high_confidence_gate_passed",
      target,
      verification,
      ...(presentation ? { presentation } : {}),
    });
  }
  return decisions;
}

export function canonicalLinkUrl(value: string | null, category?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return value;
    if (category && QUERY_IDENTITY_CATEGORIES.has(category)) {
      for (const key of [...url.searchParams.keys()]) {
        if (isDisposableQueryParam(key)) url.searchParams.delete(key);
      }
    } else {
      url.search = "";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function isDisposableQueryParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return /^utm_/.test(normalized) ||
    [
      "fbclid",
      "gclid",
      "msclkid",
      "igshid",
      "srsltid",
      "mc_cid",
      "mc_eid",
      "_branch_match_id",
    ].includes(normalized);
}

export function validateFulfillmentPlan(plan: FulfillmentPlan): string[] {
  const errors: string[] = [];
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) errors.push("unsupported_schema_version");
  if (!plan.plan_id || !plan.generated_at) errors.push("missing_plan_identity");
  if (plan.location.is_general !== false) errors.push("general_location_forbidden");
  if (!plan.request.request_key || (!plan.request.canonical_thread_ts && !plan.request.fulfillment_request_id)) errors.push("missing_request_identity");
  if (plan.request.fulfillment_request_id && plan.request.request_key !== `v2:${plan.request.fulfillment_request_id}`) errors.push("database_request_key_mismatch");
  if (plan.write_policy === "links_only" && plan.writes.some(write => write.kind === "branding" || write.category === "reservations")) errors.push("out_of_scope_link_only_write");
  if (new Set(plan.links.map((link) => link.category)).size !== plan.links.length) {
    errors.push("duplicate_link_category");
  }
  for (const [index, write] of plan.writes.entries()) {
    if (write.sequence !== index + 1) errors.push(`non_sequential_write_${write.sequence}`);
    if (!write.fill_only) errors.push(`non_fill_only_write_${write.sequence}`);
    if (!write.requires_readback) errors.push(`readback_not_required_${write.sequence}`);
  }
  if (new Set(plan.writes.map((write) => write.idempotency_key)).size !== plan.writes.length) {
    errors.push("duplicate_write_idempotency_key");
  }
  for (const write of plan.writes) {
    if (!VALID_WRITE_KINDS.has(write.kind)) {
      errors.push(`unsupported_write_kind_${String(write.kind)}`);
    }
    if (write.kind !== "branding" && write.kind !== "social" && write.scope !== "location") {
      errors.push(`non_branding_account_scope_${write.sequence}`);
    }
    if (write.kind === "social") {
      const socialFields: Record<string, string> = { facebook: "facebook_url", instagram: "instagram_url", x_twitter: "x_url", tiktok: "tiktok_url", youtube: "youtube_url" };
      const field = socialFields[write.category ?? ""];
      if (!field || Object.keys(write.payload ?? {}).length !== 1 || write.payload?.[field] !== write.url || !write.url?.startsWith("https://") || write.scope !== plan.location.branding_scope || !plan.links.some(link => link.action === "write" && link.category === write.category && link.url === write.url)) {
        errors.push(`invalid_social_write_${write.sequence}`);
      }
    }
  }
  for (const link of plan.links) {
    if (!VALID_LINK_ACTIONS.has(link.action)) {
      errors.push(`invalid_link_action_${link.category}`);
    }
    if (!VALID_LINK_TARGETS.has(link.target)) {
      errors.push(`invalid_link_target_${link.category}`);
    }
    if (link.action !== "write") continue;
    if (!AUTO_WRITE_CATEGORIES.has(link.category)) errors.push(`category_not_auto_writable_${link.category}`);
    if (REVIEW_ONLY_CATEGORIES.has(link.category)) errors.push(`review_only_category_write_${link.category}`);
    if (!link.url?.match(/^https?:\/\//i)) errors.push(`write_missing_http_url_${link.category}`);
    if (link.url !== canonicalLinkUrl(link.url, link.category)) errors.push(`write_url_has_query_params_${link.category}`);
    const expectedPresentation = link.target === "touchpoint"
      ? presentationForCategory(link.category)
      : null;
    if (expectedPresentation && JSON.stringify(link.presentation) !== JSON.stringify(expectedPresentation)) {
      errors.push(`custom_link_presentation_mismatch_${link.category}`);
    }
  }
  for (const exception of plan.model_exceptions) {
    if (!VALID_MODEL_EXCEPTION_KINDS.has(exception.kind)) {
      errors.push(`invalid_model_exception_${String(exception.kind)}`);
    }
    if (!allowedModelForException(exception.kind, exception.model)) {
      errors.push(`invalid_model_route_${exception.kind}_${exception.model}`);
    }
    if (["conflicting_candidate_tie", "unstructured_event_timing"].includes(exception.kind) && !stringValue(exception.category)) {
      errors.push(`${exception.kind}_missing_category`);
    }
  }
  if (plan.branding.fable_output) {
    const allowed = new Set(["logo_choice", "palette", "composition", "confidence", "flags", "rationale"]);
    const required = [...allowed];
    for (const key of Object.keys(plan.branding.fable_output)) {
      if (!allowed.has(key)) errors.push(`unsupported_fable_output_${key}`);
    }
    for (const key of required) {
      if (!(key in plan.branding.fable_output)) errors.push(`missing_fable_output_${key}`);
    }
    if (!isObject(plan.branding.fable_output.palette) || Object.values(plan.branding.fable_output.palette).some((color) => !/^#[0-9a-f]{6}$/i.test(String(color)))) {
      errors.push("invalid_fable_palette");
    } else {
      for (const role of Object.keys(plan.branding.fable_output.palette)) {
        if (!BRANDING_PALETTE_ROLES.has(role)) errors.push(`unsupported_fable_palette_role_${role}`);
      }
      for (const role of REQUIRED_WEB_PALETTE_ROLES) {
        if (!(role in plan.branding.fable_output.palette)) errors.push(`missing_fable_palette_role_${role}`);
      }
    }
    if (!stringValue(plan.branding.fable_output.composition)) errors.push("invalid_fable_composition");
    if (!stringValue(plan.branding.fable_output.rationale)) errors.push("invalid_fable_rationale");
    if (!VALID_CONFIDENCE.has(plan.branding.fable_output.confidence)) errors.push("invalid_fable_confidence");
    if (!Array.isArray(plan.branding.fable_output.flags) || plan.branding.fable_output.flags.some((flag) => typeof flag !== "string")) {
      errors.push("invalid_fable_flags");
    }
  }
  if (plan.branding.status === "apply" && !plan.branding.fable_output) {
    errors.push("branding_apply_missing_fable_output");
  }
  if (plan.branding.status === "reuse") {
    errors.push(...validateEffectiveBrandingQa(plan.branding.effective_branding_qa));
  }
  if (plan.location.website_url && ["apply", "reuse"].includes(plan.branding.status)) {
    errors.push(...validateWebsiteVisualQa(plan.branding.website_visual_qa));
  }
  const brandingLogo = stringValue(plan.branding.final_logo_path) ?? stringValue(plan.branding.fable_output?.logo_choice);
  if (plan.branding.status === "apply" && brandingLogo) {
    if (!stringValue(plan.branding.final_logo_path)) errors.push("branding_apply_missing_final_logo_path");
    errors.push(...validateFinalAssetQa(plan.branding.final_asset_qa));
  }
  const requiredOutputs = ["audit", "state", "notion_checklist", "slack_summary"];
  if (requiredOutputs.some((output) => !plan.required_outputs.includes(output as FulfillmentPlan["required_outputs"][number]))) {
    errors.push("missing_required_output");
  }
  return errors;
}

function presentationForCategory(category: string): LinkDecision["presentation"] | null {
  const normalized = category.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases: Record<string, keyof typeof CUSTOM_LINK_PRESENTATION> = {
    order: "ordering",
    ordering: "ordering",
    orderonline: "ordering",
    onlineordering: "ordering",
    career: "careers_jobs",
    careers: "careers_jobs",
    careersjobs: "careers_jobs",
    jobs: "careers_jobs",
    employment: "careers_jobs",
    menu: "menu",
    catering: "catering",
    event: "events",
    events: "events",
    reservation: "reservations",
    reservations: "reservations",
    reserve: "reservations",
  };
  const key = aliases[normalized];
  return key ? { ...CUSTOM_LINK_PRESENTATION[key] } : null;
}

function validateWebsiteVisualQa(qa: WebsiteVisualQa | undefined): string[] {
  if (!qa) return ["branding_missing_website_visual_qa"];
  const errors: string[] = [];
  if (qa.status !== "captured") errors.push("branding_website_visual_evidence_unavailable");
  if (!stringValue(qa.desktop_screenshot)) errors.push("branding_missing_desktop_website_screenshot");
  if (!stringValue(qa.mobile_screenshot)) errors.push("branding_missing_mobile_website_screenshot");
  if (!stringValue(qa.computed_styles_manifest)) errors.push("branding_missing_computed_styles_manifest");
  if (qa.palette_correspondence_pass !== true) errors.push("branding_palette_not_visually_corroborated");
  return errors;
}

function applyModelExceptionHolds(links: LinkDecision[], exceptions: ModelException[]): LinkDecision[] {
  const tiedCategories = new Set(
    exceptions
      .filter((exception) => exception.kind === "conflicting_candidate_tie")
      .map((exception) => exception.category)
      .filter((category): category is string => Boolean(category)),
  );
  if (!tiedCategories.size) return links;
  return links.map((link) => tiedCategories.has(link.category)
    ? {
        ...link,
        action: "hold",
        target: "none",
        reason: "conflicting_candidate_tie_requires_luna",
      }
    : link);
}

function validatePlanShape(value: unknown): string[] {
  if (!isObject(value)) return ["plan_must_be_object"];
  const errors: string[] = [];
  const request = value.request;
  const location = value.location;
  const branding = value.branding;
  const badges = value.badges;
  if (!isObject(request)) errors.push("request_must_be_object");
  else {
    if (!stringValue(request.request_key)) errors.push("request_key_missing");
    if (!stringValue(request.canonical_thread_ts) && !stringValue(request.fulfillment_request_id)) errors.push("canonical_thread_ts_missing");
    if (!new Set(["valid", "missing", "invalid", "conflict"]).has(String(request.badge_quantity_status))) {
      errors.push("invalid_badge_quantity_status");
    }
  }
  if (!isObject(location)) errors.push("location_must_be_object");
  else {
    for (const field of ["location_id", "location_name", "account_id", "account_name"]) {
      if (!stringValue(location[field])) errors.push(`location_${field}_missing`);
    }
    if (location.is_general !== false) errors.push("general_location_forbidden");
    if (!new Set(["account", "location"]).has(String(location.branding_scope))) errors.push("invalid_branding_scope");
  }
  if (!Array.isArray(value.links) || value.links.some((item) => !isObject(item))) errors.push("links_must_be_object_array");
  if (!Array.isArray(value.writes) || value.writes.some((item) => !isObject(item))) errors.push("writes_must_be_object_array");
  if (!isObject(branding)) errors.push("branding_must_be_object");
  if (!isObject(badges)) errors.push("badges_must_be_object");
  if (!Array.isArray(value.model_exceptions) || value.model_exceptions.some((item) => !isObject(item))) {
    errors.push("model_exceptions_must_be_object_array");
  }
  if (!Array.isArray(value.required_outputs)) errors.push("required_outputs_must_be_array");
  if (!Array.isArray(value.metrics)) errors.push("metrics_must_be_array");
  return errors;
}

function buildWrites(input: PlanInput, links: LinkDecision[]): WriteOperation[] {
  const writes: WriteOperation[] = [];
  const touchpointKeys = new Set<string>();
  const push = (write: Omit<WriteOperation, "sequence" | "idempotency_key" | "fill_only" | "requires_readback">) => {
    const sequence = writes.length + 1;
    writes.push({
      ...write,
      sequence,
      idempotency_key: `${input.request.canonical_thread_ts}|${input.request.request_key}|${sequence}|${write.kind}|${write.category ?? ""}`,
      fill_only: true,
      requires_readback: true,
    });
  };
  const pushTouchpoint = (category: string, url: string, payload?: JsonObject) => {
    const canonicalCategory = ["order", "ordering"].includes(category) ? "ordering" : category;
    const key = `${canonicalCategory}|${canonicalLinkUrl(url, canonicalCategory) ?? url}`;
    if (touchpointKeys.has(key)) return;
    touchpointKeys.add(key);
    push({
      kind: "touchpoint",
      scope: "location",
      category: canonicalCategory,
      url,
      ...(payload ? { payload } : {}),
    });
  };

  const brandingLinks = links.filter((link) => link.action === "write" && link.target === "branding");
  if (input.write_policy === "links_only") {
    for (const link of brandingLinks) {
      push({ kind: "social", scope: input.location.branding_scope, category: link.category, url: link.url ?? undefined,
        payload: { [locationField(link.category).replace("branding.", "")]: link.url } });
    }
  }
  const brandingPayload: JsonObject = Object.fromEntries(
    (input.write_policy === "links_only" ? [] : brandingLinks).map((link) => [locationField(link.category).replace("branding.", ""), link.url]),
  );
  if (input.branding?.status === "apply") {
    const judgment = input.branding.fable_output;
    if (!judgment) throw new Error("Branding apply requires validated Fable output");
    Object.assign(brandingPayload, {
      logo_file: input.branding.final_logo_path ?? judgment.logo_choice,
      ...judgment.palette,
      source: "validated_fable_output",
      final_asset_qa: input.branding.final_asset_qa,
    });
  }
  if (Object.keys(brandingPayload).length) {
    push({ kind: "branding", scope: input.location.branding_scope, payload: brandingPayload });
  }
  for (const link of links.filter((item) => item.action === "write" && item.target === "location")) {
    push({ kind: "location", scope: "location", category: link.category, url: link.url ?? undefined });
    if (["order", "ordering"].includes(link.category) && link.url) {
      pushTouchpoint("ordering", link.url, presentationForCategory("ordering") ?? undefined);
    }
  }
  for (const link of links.filter((item) =>
    item.action === "preserve" &&
    item.reason === "existing_verified" &&
    ["order", "ordering"].includes(item.category) &&
    item.url
  )) {
    pushTouchpoint("ordering", link.url!, presentationForCategory("ordering") ?? undefined);
  }
  for (const link of links.filter((item) => item.action === "write" && item.target === "touchpoint")) {
    if (link.url) pushTouchpoint(link.category, link.url, link.presentation);
  }
  const verifiedSocialsPresent = links.some((link) =>
    ["write", "preserve"].includes(link.action) &&
    ["instagram", "facebook", "tiktok", "youtube", "x_twitter"].includes(link.category),
  );
  if (input.write_policy === "links_only" || verifiedSocialsPresent || writes.some((write) => write.kind === "touchpoint")) {
    push({
      kind: "linktree_defaults",
      scope: "location",
      payload: {
        verified_socials_present: verifiedSocialsPresent,
      },
    });
  }
  return writes;
}

function deterministicGateFailure(
  category: string,
  verification: JsonObject,
  writeGate: JsonObject,
): string | null {
  if (REVIEW_ONLY_CATEGORIES.has(category)) return "category_requires_human_review";
  if (!AUTO_WRITE_CATEGORIES.has(category)) return "category_not_auto_writable";
  if (stringValue(verification.status) !== "verified") return "verification_status_not_verified";
  if (stringValue(verification.liveness) !== "live") return "destination_not_live";
  if (stringValue(verification.relevance) !== "match") return "location_relevance_not_matched";
  const page = asObject(verification.page_evidence);
  const renderedText = stringValue(page.text_sample) ?? "";
  if (/page (?:you(?:'|’)re looking for|not found)|unable to find the page|\b404\b/i.test(renderedText) &&
      renderedText.length < 700) return "rendered_error_page_requires_review";
  const evidence = [
    ...stringArray(verification.validity_evidence),
    ...stringArray(verification.location_match_evidence),
    stringValue(verification.rejection_reason),
  ].filter(Boolean).join(" ");
  if (/security_or_bot_challenge_detected=true|fetch_timeout_soft=true/i.test(evidence)) {
    return "challenge_or_timeout_requires_review";
  }
  if (/http_status=(?:4\d\d|5\d\d)|\b(?:404|410|page not found|not found|unavailable|doesn.t exist)\b/i.test(evidence)) {
    return "hard_negative_destination_evidence";
  }
  if (category === "events") {
    const eventTiming = asObject(verification.event_timing);
    if (eventTiming.has_upcoming_event !== true || !asArray(eventTiming.upcoming_event_dates).length) {
      return "events_missing_upcoming_structured_date";
    }
    if (stringValue(eventTiming.source) === "gpt-5.6-luna" && !validLunaEventTiming(eventTiming)) {
      return "events_invalid_luna_review";
    }
  }
  if (["menu", "events", "careers_jobs", "catering", "reservations"].includes(category) && stringValue(verification.source_type) !== "website") {
    return "first_party_evidence_required";
  }
  if (["events", "catering", "reservations"].includes(category) && writeGate.custom_destination_specific !== true) {
    return "destination_not_category_specific";
  }
  return null;
}

function badgeDecision(request: FulfillmentPlan["request"]): FulfillmentPlan["badges"] {
  return {
    action: "none",
    quantity: request.badge_quantity,
    reason: "owned_by_fulfillment_request",
  };
}

function allowedModelForException(kind: ModelExceptionKind, model: ModelException["model"]): boolean {
  if (["multiple_plausible_logos", "palette_or_composition", "branding_quality_gate_failure"].includes(kind)) {
    return model === "fable";
  }
  if (["conflicting_candidate_tie", "unstructured_event_timing"].includes(kind)) return model === "luna";
  return model === "sol";
}

function validLunaEventTiming(eventTiming: JsonObject): boolean {
  const review = asObject(eventTiming.luna_review);
  const events = asArray(review.events).map(asObject);
  return review.status === "accepted" &&
    review.model === "gpt-5.6-luna" &&
    review.verdict === "upcoming_events_verified" &&
    typeof review.evidence_hash === "string" && /^[a-f0-9]{64}$/.test(review.evidence_hash) &&
    typeof review.confidence === "number" && review.confidence >= 0.9 && review.confidence <= 1 &&
    events.some((event) => typeof event.normalized_start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(event.normalized_start_date));
}

function locationField(category: string): string {
  const fields: Record<string, string> = {
    instagram: "branding.instagram_url",
    facebook: "branding.facebook_url",
    tiktok: "branding.tiktok_url",
    youtube: "branding.youtube_url",
    x_twitter: "branding.x_url",
    ios_app: "branding.apple_app_url",
    android_app: "branding.google_app_url",
    ordering: "locations.ordering_url",
  };
  return fields[category] ?? "";
}

function candidateUrl(candidate: JsonObject): string | null {
  return stringValue(candidate.input_url) ?? stringValue(candidate.final_url);
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function isObject(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateEffectiveBrandingQa(qa: EffectiveBrandingQa | undefined): string[] {
  if (!qa) return ["branding_reuse_missing_effective_qa"];

  const errors: string[] = [];
  if (!stringValue(qa.proof_path)) errors.push("branding_reuse_missing_effective_proof");
  if (qa.proof_validation_pass !== true) errors.push("branding_reuse_proof_validation_failed");
  if (!stringValue(qa.logo_surface_verdict)) errors.push("branding_reuse_logo_surface_verdict_missing");
  if (qa.logo_surface_pass !== true || qa.logo_surface_verdict !== "ok") {
    errors.push("branding_reuse_logo_surface_failed");
  }
  return errors;
}

function validateFinalAssetQa(qa: FinalAssetQa | undefined): string[] {
  if (!qa) return ["branding_apply_missing_final_asset_qa"];

  const errors: string[] = [];
  if (qa.ship_gate_pass !== true) errors.push("branding_ship_gate_failed");
  if (qa.border_dust_pass !== true) errors.push("branding_border_dust_failed");
  if (qa.soft_fringe_pass !== true) errors.push("branding_soft_fringe_failed");
  if (qa.source_preservation_pass !== true) errors.push("branding_source_preservation_failed");
  if (!isUnitInterval(qa.interior_low_contrast_share)) errors.push("branding_interior_gate_missing");
  else if (qa.interior_low_contrast_share > MAX_INTERIOR_LOW_CONTRAST_SHARE) errors.push("branding_interior_contrast_failed");
  if (!Number.isInteger(qa.upload_bytes) || qa.upload_bytes <= 0 || qa.upload_bytes > MAX_LOGO_UPLOAD_BYTES) {
    errors.push("branding_logo_upload_size_failed");
  }
  return errors;
}
