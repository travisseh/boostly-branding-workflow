import { parseFulfillmentPlan, type FulfillmentPlan, type LinkDecision, type WriteOperation } from "./fulfillment-plan.ts";

export type ExecutionRecord = {
  operation: WriteOperation;
  outcome: "applied" | "dry_run" | "skipped_existing" | "held" | "error";
  reason?: string;
  before?: unknown;
  after?: unknown;
  readback?: unknown;
  /** gates.ts verdict recorded for branding writes (SHIP or SHIP-WITH-OVERRIDE; HOLD never reaches a record). */
  gate_verdict?: { verdict: "SHIP" | "SHIP-WITH-OVERRIDE" | "HOLD"; reasons: string[] } & Record<string, unknown>;
};

export type FulfillmentArtifacts = {
  boostly_account_url: string;
  official_website_url: string | null;
  official_website_reason?: string;
  notion_review_url: string | null;
  notion_review_reason?: string;
  link_tree_screenshot: "attached" | "unavailable";
  link_tree_url?: string | null;
  link_tree_reason?: string;
  branding_proof_screenshot?: "attached" | "unavailable";
  branding_proof_reason?: string;
  source_photo_count?: number;
  branding_case_id: string | null;
  branding_outcome: "applied" | "held" | "reused";
  branding_reason: string;
};

export type FulfillmentResult = {
  plan: FulfillmentPlan;
  execution: ExecutionRecord[];
  artifacts: FulfillmentArtifacts;
  operational_blockers?: string[];
};

export function parseFulfillmentResult(value: unknown): FulfillmentResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Fulfillment result must be an object");
  const result = value as FulfillmentResult;
  result.plan = parseFulfillmentPlan(result.plan);
  if (!Array.isArray(result.execution)) throw new Error("Fulfillment execution must be an array");
  if (result.execution.length !== result.plan.writes.length) throw new Error("Fulfillment execution does not cover every planned write");
  for (const [index, record] of result.execution.entries()) {
    const planned = result.plan.writes[index];
    if (!record || record.operation?.idempotency_key !== planned.idempotency_key) {
      throw new Error(`Execution operation ${index + 1} does not match the plan`);
    }
    if (!["applied", "skipped_existing", "held", "error"].includes(record.outcome)) {
      throw new Error(`Execution outcome ${index + 1} is not final: ${String(record.outcome)}`);
    }
    if (["applied", "skipped_existing"].includes(record.outcome) && record.readback == null) {
      throw new Error(`Execution operation ${index + 1} is missing production readback`);
    }
  }
  if (!result.artifacts || !/^https:\/\//.test(result.artifacts.boostly_account_url)) {
    throw new Error("Fulfillment artifacts require a Boostly account URL");
  }
  if (result.artifacts.link_tree_screenshot === "attached" && !result.artifacts.link_tree_url) {
    throw new Error("Attached link-tree proof requires the verified live link-tree URL");
  }
  if (result.artifacts.branding_outcome === "applied" && (
    result.artifacts.branding_proof_screenshot !== "attached" || !result.artifacts.branding_case_id
  )) {
    throw new Error("Applied branding requires a branding case and production-readback proof screenshot");
  }
  return result;
}

export function renderSlackSummary(result: FulfillmentResult): string {
  const applied = appliedLinks(result);
  const held = heldLinks(result);
  const unresolved = unresolvedLinks(result);
  const lines = [
    `<${result.artifacts.boostly_account_url}|Open Boostly account>`,
    result.artifacts.official_website_url
      ? `<${result.artifacts.official_website_url}|Open official website>`
      : `Official website: unavailable (${result.artifacts.official_website_reason ?? "not verified"})`,
    "",
    `Added ${applied.length} links, held ${held.length} for review, unresolved ${unresolved.length}`,
  ];
  if (applied.length) {
    lines.push("", "Verified writes:");
    for (const link of applied) lines.push(`- ${displayCategory(link.category)}: ${link.url}`);
  }
  if (held.length) {
    lines.push("", "Held for review:");
    for (const link of held) {
      lines.push(`- ${displayCategory(link.category)}: ${link.url ?? "unresolved"} — ${displayReason(link.reason)}`);
    }
  }
  if (unresolved.length) {
    lines.push("", "Unresolved categories:");
    for (const link of unresolved) lines.push(`- ${displayCategory(link.category)}: ${displayReason(link.reason)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderNotionChecklist(result: FulfillmentResult): string {
  if (result.plan.write_policy === "links_only") return renderLinkOnlyChecklist(result);
  const applied = appliedLinks(result);
  const held = heldLinks(result);
  const unresolved = unresolvedLinks(result);
  const plan = result.plan;
  const lines = [
    `# Boosted Box Fulfillment Review - ${plan.location.location_name} - ${plan.request.fulfillment_request_id ?? plan.request.canonical_thread_ts}`,
    "",
    "## Request",
    `- Request key: \`${plan.request.request_key}\``,
    `- Location: ${plan.location.location_name}`,
    `- Account: ${plan.location.account_name}`,
    `- Branding scope: ${plan.location.branding_scope}`,
    `- Boostly account: [Open account](${result.artifacts.boostly_account_url})`,
    result.artifacts.official_website_url
      ? `- Official website: [Open website](${result.artifacts.official_website_url})`
      : `- Official website: unavailable (${result.artifacts.official_website_reason ?? "not verified"})`,
    "",
    "## Verified writes",
    ...(applied.length
      ? applied.map((link) => `- [x] ${displayCategory(link.category)}: ${link.url}`)
      : ["- [x] No link writes were required"]),
    "",
    "## Held for review",
    ...(held.length
      ? held.map((link) => `- [ ] ${displayCategory(link.category)}: ${link.url ?? "unresolved"} — ${displayReason(link.reason)}`)
      : ["- [x] No held link candidates"]),
    "",
    "## Unresolved categories",
    ...(unresolved.length
      ? unresolved.map((link) => `- [ ] ${displayCategory(link.category)}: ${displayReason(link.reason)}`)
      : ["- [x] No unresolved categories"]),
    "",
    "## Branding",
    `- Outcome: ${result.artifacts.branding_outcome}`,
    `- Reason: ${result.artifacts.branding_reason}`,
    `- Branding case: ${result.artifacts.branding_case_id ?? "unavailable"}`,
    `- Flags: ${plan.branding.flags.length ? plan.branding.flags.join(", ") : "none"}`,
    "",
    "## Proof",
    result.artifacts.link_tree_screenshot === "attached"
      ? "- Link tree proof: attached and validated"
      : `- Link tree proof: unavailable (${result.artifacts.link_tree_reason ?? "validation failed"})`,
    result.artifacts.link_tree_url
      ? `- Live link tree: [Open live link tree](${result.artifacts.link_tree_url})`
      : `- Live link tree: unavailable (${result.artifacts.link_tree_reason ?? "not verified"})`,
    result.artifacts.branding_proof_screenshot === "attached"
      ? result.artifacts.branding_outcome === "held"
        ? "- Branding proposal proof: attached and mechanically validated; production remains unchanged"
        : "- Branding proof: attached and production-readback validated"
      : `- Branding proof: unavailable (${result.artifacts.branding_proof_reason ?? "not produced"})`,
    `- GBP source photos attached: ${result.artifacts.source_photo_count ?? 0}`,
    "",
    "## Cam review gate",
    "- [ ] Cam must review and explicitly approve every held or unresolved item before any additional production write.",
  ];
  return `${lines.join("\n")}\n`;
}

export type BatchReviewFailure = { request_id: string; location_name: string; reason: string };

export function renderBatchNotionReview(values: unknown[], failures: BatchReviewFailure[] = []): string {
  const results = values.map(parseFulfillmentResult);
  for (const failure of failures) {
    if (!failure.request_id || !failure.location_name || !failure.reason) throw new Error("Incomplete discovery failure metadata");
  }
  const review = results.filter(result => heldLinks(result).length || result.operational_blockers?.length || result.execution.some(record => record.outcome === "error"));
  const heldCount = review.reduce((count, result) => count + heldLinks(result).length, 0);
  const lines = [
    "# Fulfillment Link Review",
    "",
    `${results.length} request results checked. ${review.length} requests require review or technical follow-up. ${heldCount} held category decisions.`,
    ...(failures.length ? [`${failures.length} additional requests have incomplete discovery. They are not included in the checked-result count.`] : []),
    "Held links are not counted as successful writes. Missing categories are not automatically customer requirements.",
    "Wrong-location candidates must not be approved for the current location.",
  ];
  for (const result of review) {
    lines.push("", `## ${result.plan.location.location_name}`, "",
      `Request: ${result.plan.request.fulfillment_request_id ?? result.plan.request.request_key}`,
      `Checked: ${result.plan.generated_at}`,
      `[Boostly account](${result.artifacts.boostly_account_url})`);
    if (result.artifacts.notion_review_url) lines.push(`[Full request evidence](${result.artifacts.notion_review_url})`);
    if (result.artifacts.official_website_url) lines.push(`[Official website](${result.artifacts.official_website_url})`);
    for (const link of heldLinks(result)) {
      lines.push("", `- [ ] ${displayCategory(link.category)}: ${link.url ?? "No candidate URL"}`,
        `Reason: ${displayReason(link.reason)}`,
        `Next action: ${reviewAction(link.reason)}`);
    }
    const blockers = [...new Set([...(result.operational_blockers ?? []), ...result.execution.filter(record => record.outcome === "error").map(record => record.reason ?? "Execution failed")])];
    for (const reason of blockers) lines.push("", `- [ ] Technical blocker: ${reason}`, "Next action: resolve the tooling failure, rerun verification, and confirm production readback.");
    const unresolved = unresolvedLinks(result);
    if (unresolved.length) lines.push("", "Categories without a verified candidate (not proof that the business offers them):", ...unresolved.map(link => `- ${displayCategory(link.category)}: ${displayReason(link.reason)}`));
  }
  if (failures.length) lines.push("", "## Pending Automation Work", "These requests need verification to finish, not customer approval.");
  for (const failure of failures) {
    lines.push("", `### Incomplete Discovery: ${failure.location_name}`, `Request: ${failure.request_id}`,
      `- [ ] ${failure.reason}`, "Next action: complete browser verification before attempting any new link writes. No successful current-run result is claimed for this request.");
  }
  if (!review.length && !failures.length) lines.push("", "No held links or operational blockers remain.");
  return `${lines.join("\n")}\n`;
}

function reviewAction(reason: string): string {
  if (/social.*(endpoint|deploy|writer)/i.test(reason)) return "Retry with the current socials set CLI using a fresh dry-run and its expected-state-hash. Verify the saved URLs and unchanged branding; no new endpoint deployment is required.";
  if (/wrong|different location|cleveland.*charlotte|charlotte.*cleveland/i.test(reason)) return "Reject this location-mismatched candidate. Supply or discover the correct location URL.";
  if (/existing|conflict|duplicate/i.test(reason)) return "Keep the current URL unless an owner explicitly authorizes its replacement; compare the existing and proposed destinations.";
  if (/upcoming event|private.event|past.only/i.test(reason)) return "Leave Events disabled unless a current, dated upcoming customer event is confirmed. Private-event booking copy alone does not qualify.";
  if (/bot|challenge/i.test(reason)) return "Check the destination in a normal browser without bypassing security challenges, and confirm exact business/location ownership before approval.";
  if (reason === "category_requires_human_review") return "Verify the exact location and approve or reject this review-only category.";
  return "Confirm the destination is functional and belongs to this exact business/location. Approve only with supporting evidence, otherwise reject or supply a replacement.";
}

function renderLinkOnlyChecklist(result: FulfillmentResult): string {
  const { plan } = result;
  const written = appliedLinks(result);
  const held = heldLinks(result);
  const unresolved = unresolvedLinks(result);
  const adjusted = result.execution.filter(record => record.outcome === "applied" && isReconciledExisting(record));
  const existing = plan.links.filter(link => link.action === "preserve" || result.execution.some(record => record.outcome === "skipped_existing" && record.operation.category === link.category));
  return [
    `# Boosted Box Fulfillment Review - ${plan.location.location_name} - ${plan.request.fulfillment_request_id ?? plan.request.canonical_thread_ts}`,
    "", `## Current Result ${plan.generated_at}`, "This result supersedes any earlier result on this page.",
    "", `- Fulfillment request: ${plan.request.fulfillment_request_id ?? plan.request.request_key}`,
    `- Location: ${plan.location.location_name}`, `- Account: [${plan.location.account_name}](${result.artifacts.boostly_account_url})`,
    result.artifacts.official_website_url ? `- Website: [Official website](${result.artifacts.official_website_url})` : "- Website unavailable",
    `- Added ${written.length}; held ${held.length}; unresolved ${unresolved.length}.`,
    "", "## Verified writes", ...written.map(link => `- [x] ${displayCategory(link.category)}: ${link.url}`),
    ...(!written.length ? ["- No new links were written in this pass."] : []),
    "", "## Existing Link Settings Updated", ...adjusted.map(record => `- ${displayCategory(record.operation.category ?? "link")}: ${record.operation.url} (existing URL preserved; presentation or activation updated)`),
    "", "## Preserved links", ...existing.map(link => `- ${displayCategory(link.category)}: ${link.url}`),
    "", "## Held for review", ...held.map(link => `- [ ] ${displayCategory(link.category)}: ${link.url ?? "unresolved"} - ${displayReason(link.reason)}`),
    "", "## Unresolved categories", ...unresolved.map(link => `- [ ] ${displayCategory(link.category)}: ${displayReason(link.reason)}`),
    "", "## Operational blockers", ...(result.operational_blockers?.length ? result.operational_blockers.map(reason => `- [ ] ${reason}`) : ["- None"]),
    "", "## Production readbacks", ...result.execution.map(record => `- ${record.operation.category ?? record.operation.kind}: ${record.outcome}${record.reason ? ` (${record.reason})` : ""}`),
    "", "## Review", "- [ ] Approve held candidates before any additional production write.",
  ].join("\n") + "\n";
}

export function buildAuditRows(result: FulfillmentResult): Array<Record<string, unknown>> {
  const bySequence = new Map(result.execution.map((record) => [record.operation.sequence, record]));
  const rows: Array<Record<string, unknown>> = result.plan.writes.map((operation) => {
    const record = bySequence.get(operation.sequence);
    return {
      run_id: result.plan.plan_id,
      slack_request_ts: result.plan.request.canonical_thread_ts,
      fulfillment_request_id: result.plan.request.fulfillment_request_id ?? null,
      request_key: result.plan.request.request_key,
      account_id: result.plan.location.account_id,
      location_id: result.plan.location.location_id,
      event: eventForOperation(operation),
      category: operation.category ?? null,
      proposed_url: operation.url ?? null,
      outcome: record?.outcome ?? "not_executed",
      reason: record?.reason ?? null,
      idempotency_key: operation.idempotency_key,
      before: record?.before ?? null,
      after: record?.after ?? null,
      readback: record?.readback ?? null,
      recorded_at: new Date().toISOString(),
    };
  });
  if (result.plan.request.fulfillment_request_id) rows.push({
    run_id: result.plan.plan_id, event: "fulfillment_request_review", fulfillment_request_id: result.plan.request.fulfillment_request_id,
    request_key: result.plan.request.request_key, location_id: result.plan.location.location_id,
    idempotency_key: `${result.plan.plan_id}|review|${result.plan.generated_at}`,
    held_links: heldLinks(result), unresolved_links: unresolvedLinks(result), operational_blockers: result.operational_blockers ?? [],
    slack_posting: "not_requested", slack_file_ids: [], recorded_at: new Date().toISOString(),
  });
  if (result.plan.request.fulfillment_request_id && result.artifacts.notion_review_url) rows.push({
    run_id: result.plan.plan_id, event: "notion_review", fulfillment_request_id: result.plan.request.fulfillment_request_id,
    location_id: result.plan.location.location_id, outcome: "verified", notion_review_url: result.artifacts.notion_review_url,
    idempotency_key: `${result.plan.plan_id}|notion|${result.artifacts.notion_review_url}`,
    slack_posting: "not_requested", slack_file_ids: [], recorded_at: new Date().toISOString(),
  });
  return rows;
}

export function buildStatePatch(result: FulfillmentResult): Record<string, unknown> {
  const concluded = result.execution.length === result.plan.writes.length && result.execution.every((record) =>
    ["applied", "skipped_existing", "held"].includes(record.outcome),
  );
  const status = !concluded || result.operational_blockers?.length ? "blocked" : heldLinks(result).length ? "needs_review" : "completed";
  const terminal = concluded && (!result.plan.request.fulfillment_request_id || status === "completed");
  return {
    execution_concluded: concluded,
    add_processed_request_key: terminal ? result.plan.request.request_key : null,
    add_processed_fulfillment_request_id: terminal ? result.plan.request.fulfillment_request_id ?? null : null,
    fulfillment_request_id: result.plan.request.fulfillment_request_id ?? null,
    fulfillment_request_outcome: {
      status,
      checked_at: new Date().toISOString(), location_id: result.plan.location.location_id,
      added: appliedLinks(result).length, held: heldLinks(result).length, unresolved: unresolvedLinks(result).length,
      blockers: result.operational_blockers ?? [],
    },
    add_processed_message_ts: concluded && !result.plan.request.fulfillment_request_id ? result.plan.request.canonical_thread_ts : null,
    add_processed_badge_request_id: null,
    last_processed_ts: result.plan.request.fulfillment_request_id ? null : result.plan.request.canonical_thread_ts,
    last_checked_at: new Date().toISOString(),
    last_run: `links=${appliedLinks(result).length} held=${heldLinks(result).length}`,
  };
}

function isReconciledExisting(record: ExecutionRecord): boolean {
  return record.after != null && typeof record.after === "object" && (record.after as Record<string, unknown>).reconciled_existing === true;
}

function appliedLinks(result: FulfillmentResult): LinkDecision[] {
  const appliedCategories = new Set<string>();
  const socialCategoryByField: Record<string, string> = {
    instagram_url: "instagram",
    facebook_url: "facebook",
    tiktok_url: "tiktok",
    youtube_url: "youtube",
    x_url: "x_twitter",
  };
  for (const record of result.execution.filter((item) => item.outcome === "applied" && !isReconciledExisting(item))) {
    if (record.operation.category) appliedCategories.add(record.operation.category);
    if (record.operation.kind === "branding") {
      for (const [field, category] of Object.entries(socialCategoryByField)) {
        if (typeof record.operation.payload?.[field] === "string") appliedCategories.add(category);
      }
    }
  }
  const links = result.plan.links.filter((link) => link.action === "write" && appliedCategories.has(link.category));
  return [...new Map(links.map((link) => [
    `${link.category === "order" ? "ordering" : link.category}|${link.url ?? ""}`,
    link,
  ])).values()];
}

function heldLinks(result: FulfillmentResult): LinkDecision[] {
  const planned = result.plan.links.filter((link) => link.action === "hold");
  const executionHolds: LinkDecision[] = result.execution
    .filter((record) => ["held", "error"].includes(record.outcome) && record.operation.category)
    .flatMap((record): LinkDecision[] => {
      const link = result.plan.links.find((candidate) => candidate.category === record.operation.category);
      return link ? [{ ...link, action: "hold", reason: record.reason ?? record.outcome }] : [];
    });
  return [...new Map([...planned, ...executionHolds].map((link) => [link.category, link])).values()];
}

function unresolvedLinks(result: FulfillmentResult): LinkDecision[] {
  return result.plan.links.filter((link) => link.action === "not_found");
}

function eventForOperation(operation: WriteOperation): string {
  if (operation.kind === "branding") return "branding_write";
  if (operation.kind === "linktree_defaults") return "linktree_defaults";
  return "link_write";
}

function displayCategory(category: string): string {
  const names: Record<string, string> = {
    ordering: "Ordering",
    order: "Order",
    careers_jobs: "Careers",
    x_twitter: "X",
  };
  return names[category] ?? category.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function displayReason(reason: string): string {
  if (reason === "category_requires_human_review") {
    return "This category requires human approval under the current write policy.";
  }
  return reason;
}
