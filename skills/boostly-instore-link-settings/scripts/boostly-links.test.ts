import assert from "node:assert/strict";
import test from "node:test";

import { canonicalEventUrl, socialLinksPayload } from "./boostly-links.ts";

test("social URL payload contains only requested social fields and defaults to dry-run", () => {
  assert.deepEqual(socialLinksPayload({ "instagram-url": "https://instagram.com/example" }, "location"), {
    scope: "location", links: { instagram_url: "https://instagram.com/example" }, dry_run: true,
  });
  assert.equal(socialLinksPayload({ "facebook-url": "https://facebook.com/example", apply: true }, "account").dry_run, false);
  for (const flag of ["logo-file", "logo-attachment-id", "web-primary-color", "print-secondary-color", "apple-app-url", "clear", "ordering-url", "unknown"]) {
    assert.throws(() => socialLinksPayload({ "instagram-url": "https://instagram.com/example", [flag]: "bad" }, "account"), /does not accept/);
  }
  for (const url of ["", "http://instagram.com/example", "https://user:pass@instagram.com/example"]) {
    assert.throws(() => socialLinksPayload({ "instagram-url": url }, "account"));
  }
});

test("custom-event duplicate matching canonicalizes harmless URL variation", () => {
  assert.equal(
    canonicalEventUrl("https://WWW.Example.com/jobs/?utm_source=slack&b=2&a=1#apply"),
    "https://example.com/jobs?a=1&b=2",
  );
  assert.equal(canonicalEventUrl("not a URL"), "not a URL");
  assert.equal(canonicalEventUrl(null), null);
  assert.equal(
    canonicalEventUrl("https://panzanellasnewmarket.foodtecsolutions.com/ordering/home?source=pop_up&spot_id=423225&destination=order&promotion=custom_promotion"),
    "https://panzanellasnewmarket.foodtecsolutions.com/ordering/home?spot_id=423225",
  );
});

import {
  assertExpectedLogoAttachment,
  expectedLogoIdFromReadback,
  logoReplayInfo,
  logoUploadedAtFromUrl,
} from "./boostly-links.ts";

const row = (logo_attachment_id: string | null, extra: Record<string, unknown> = {}) => ({
  web_primary_color: "#B23311",
  web_secondary_color: "#353638",
  web_text_color: "#FFFFFF",
  print_primary_color: "#B23311",
  print_secondary_color: "#353638",
  print_text_color: "#FFFFFF",
  print_text_secondary_color: null,
  logo_attachment_id,
  facebook_url: null,
  instagram_url: null,
  x_url: null,
  tiktok_url: null,
  youtube_url: null,
  apple_app_url: null,
  google_app_url: null,
  logo_url: null,
  logo_filename: null,
  ...extra,
});

test("logo uploaded_at is parsed from the attachment URL timestamp prefix", () => {
  assert.equal(
    logoUploadedAtFromUrl(
      "https://boostly-attachments.s3.us-west-2.amazonaws.com/2026-09-09T21-49-57-960Z-4f581b83f9e1bb48.png",
    ),
    "2026-09-09T21:49:57.960Z",
  );
  assert.equal(logoUploadedAtFromUrl("https://example.com/logo.png"), null);
  assert.equal(logoUploadedAtFromUrl(null), null);
});

test("logo_replay describes the logo that will be carried forward", () => {
  const info = logoReplayInfo(
    row("mqg6jtsd7t4142pen3phj2nm", {
      logo_filename: "card-final.png",
      logo_url:
        "https://boostly-attachments.s3.us-west-2.amazonaws.com/2026-09-09T21-49-57-960Z-4f581b83f9e1bb48.png",
    }),
  );
  assert.deepEqual(info, {
    attachment_id: "mqg6jtsd7t4142pen3phj2nm",
    filename: "card-final.png",
    uploaded_at: "2026-09-09T21:49:57.960Z",
    note: "replayed unchanged; pass --expect-from-readback to guard",
  });
});

test("expected logo id derives from the branding get shape at the selected scope", () => {
  const readback = {
    selected_scope: "account",
    account_branding: row("acct-logo"),
    override_branding: row("override-logo"),
    effective_branding: row("override-logo"),
  };
  assert.deepEqual(expectedLogoIdFromReadback(readback, "account"), {
    attachment_id: "acct-logo",
    source: "account_branding",
  });
  assert.deepEqual(expectedLogoIdFromReadback(readback, "location"), {
    attachment_id: "override-logo",
    source: "override_branding",
  });
});

test("expected logo id derives from the branding set --apply output shape", () => {
  const applied = {
    success_result: { success: true },
    selected_scope: "location",
    readback: {
      account_branding: row("acct-logo"),
      override_branding: row("override-logo"),
      effective_branding: row("override-logo"),
    },
  };
  assert.deepEqual(expectedLogoIdFromReadback(applied, "location"), {
    attachment_id: "override-logo",
    source: "readback.override_branding",
  });
  assert.deepEqual(expectedLogoIdFromReadback(applied, "account"), {
    attachment_id: "acct-logo",
    source: "readback.account_branding",
  });
});

test("expected logo id falls back to effective_branding when the scoped row is missing", () => {
  const readback = {
    account_branding: row("acct-logo"),
    override_branding: null,
    effective_branding: row("acct-logo"),
  };
  assert.deepEqual(expectedLogoIdFromReadback(readback, "location"), {
    attachment_id: "acct-logo",
    source: "effective_branding",
  });
  assert.throws(
    () => expectedLogoIdFromReadback({ nothing: true }, "account"),
    /no account_branding or effective_branding row/,
  );
  assert.throws(() => expectedLogoIdFromReadback("nope", "account"), /not a JSON object/);
});

test("mismatched replayed logo refuses the write and names both ids", () => {
  // Swine Dining 2026-09-09: we wrote lompmyfq..., an app user uploaded j6slxtng...
  const current = row("j6slxtng6iu3ct0y4iucjh0n", {
    logo_filename: "IMG_4412.jpg",
    logo_url:
      "https://boostly-attachments.s3.us-west-2.amazonaws.com/2026-09-09T03-12-08-001Z-deadbeef.jpg",
  });
  assert.throws(
    () =>
      assertExpectedLogoAttachment(
        current,
        { attachment_id: "lompmyfq8n479u5jxpjv1wgj", source: "production-readback.json (account_branding)" },
        "account",
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { exitCode?: number }).exitCode, 6);
      assert.match(error.message, /j6slxtng6iu3ct0y4iucjh0n/);
      assert.match(error.message, /lompmyfq8n479u5jxpjv1wgj/);
      assert.match(error.message, /IMG_4412\.jpg/);
      assert.match(error.message, /2026-09-09T03-12-08-001Z-deadbeef\.jpg/);
      assert.match(error.message, /--logo-file/);
      assert.match(error.message, /--expect-logo-attachment-id j6slxtng6iu3ct0y4iucjh0n/);
      return true;
    },
  );
  // Expected a logo, row has none: also a mismatch.
  assert.throws(
    () =>
      assertExpectedLogoAttachment(row(null), { attachment_id: "x", source: "flag" }, "location"),
    /would replay logo attachment null/,
  );
});

test("matching replayed logo passes, including both-null", () => {
  assert.doesNotThrow(() =>
    assertExpectedLogoAttachment(
      row("mqg6jtsd7t4142pen3phj2nm"),
      { attachment_id: "mqg6jtsd7t4142pen3phj2nm", source: "flag" },
      "account",
    ),
  );
  assert.doesNotThrow(() =>
    assertExpectedLogoAttachment(row(null), { attachment_id: null, source: "flag" }, "account"),
  );
});

// ---- server-action id rotation: detector, once-only self-heal, loader ----

import {
  ActionRotatedError,
  isActionNotFoundResponse,
  loadActionIds,
  withActionRotationHeal,
} from "./boostly-links.ts";
import {
  deriveActionIds,
  diffActionIds,
  extractBuildId,
  fillPage,
  mergeActionIdsFile,
  scanChunkForActions,
} from "./derive-actions.ts";

const H = (pairs: Record<string, string> = {}) => ({
  get: (name: string) => pairs[name.toLowerCase()] ?? null,
});

test("rotation detector matches only the exact Next 'action not found' signature", () => {
  // Probed live 2026-09-16 with a well-formed fake id.
  assert.ok(isActionNotFoundResponse(404, H({ "x-nextjs-action-not-found": "1" }), "Server action not found."));
  assert.ok(isActionNotFoundResponse(404, H(), "Server action not found.\n"));
  assert.ok(isActionNotFoundResponse(404, H({ "x-nextjs-action-not-found": "1" }), ""));
  // A page 404 from a wrong account scope: HTML body, no header.
  assert.equal(isActionNotFoundResponse(404, H(), "<!DOCTYPE html><html>This page could not be found.</html>"), false);
  assert.equal(isActionNotFoundResponse(500, H({ "x-nextjs-action-not-found": "1" }), "Server action not found."), false);
  assert.equal(isActionNotFoundResponse(200, H(), "0:{}\n1:[]"), false);
});

function healHarness(opts: { rotatedIds: Set<string>; healTo: string; isRead?: boolean }) {
  const ids: Record<string, string> = { getEvents: "old-id", saveEvents: "old-id" };
  const attempts: string[] = [];
  const logs: string[] = [];
  let heals = 0;
  const attempt = async (id: string) => {
    attempts.push(id);
    return opts.rotatedIds.has(id)
      ? { status: 404, headers: H({ "x-nextjs-action-not-found": "1" }), text: "Server action not found." }
      : { status: 200, headers: H(), text: `0:{}\n1:{"ok":"${id}"}` };
  };
  const state = { healed: false };
  const deps = {
    ids,
    isRead: () => opts.isRead ?? true,
    heal: async () => {
      heals += 1;
      ids.getEvents = opts.healTo;
      ids.saveEvents = opts.healTo;
      return {
        from_build: "buildA",
        to_build: "buildB",
        changed: [{ key: "getEvents" as const, from: "old-id", to: opts.healTo }],
        missing: [],
        file: "/x/action-ids.json",
      };
    },
    state,
    log: (line: string) => logs.push(line),
  };
  return { ids, attempts, logs, deps, state, attempt, heals: () => heals };
}

test("read action: rotation heals once, retries once with the new id, logs one stderr line", async () => {
  const h = healHarness({ rotatedIds: new Set(["old-id"]), healTo: "new-id" });
  const result = await withActionRotationHeal("getEvents", h.attempt, h.deps);
  assert.equal(result.status, 200);
  assert.deepEqual(h.attempts, ["old-id", "new-id"]);
  assert.equal(h.heals(), 1);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /self-heal: server action ids rotated \(build buildA -> buildB\); re-derived getEvents/);
  assert.equal(h.state.healed, true);
});

test("read action: no rotation means no heal and a single attempt", async () => {
  const h = healHarness({ rotatedIds: new Set(), healTo: "new-id" });
  await withActionRotationHeal("getEvents", h.attempt, h.deps);
  assert.deepEqual(h.attempts, ["old-id"]);
  assert.equal(h.heals(), 0);
  assert.equal(h.logs.length, 0);
});

test("read action: still rotated after the retry -> clear error, no loop", async () => {
  const h = healHarness({ rotatedIds: new Set(["old-id", "new-id"]), healTo: "new-id" });
  await assert.rejects(
    () => withActionRotationHeal("getEvents", h.attempt, h.deps),
    (error: unknown) => error instanceof ActionRotatedError && error.actionKey === "getEvents" && /still unknown/.test(error.message),
  );
  assert.deepEqual(h.attempts, ["old-id", "new-id"]);
  assert.equal(h.heals(), 1);
});

test("heal that yields no new id for the failing action -> error naming the action, no retry", async () => {
  const h = healHarness({ rotatedIds: new Set(["old-id"]), healTo: "old-id" });
  await assert.rejects(
    () => withActionRotationHeal("getEvents", h.attempt, h.deps),
    /getEvents \(old-id\) is unknown to production and the self-heal could not derive/,
  );
  assert.deepEqual(h.attempts, ["old-id"]);
});

test("write action: rotation heals the table but aborts before any retry with a rerun instruction", async () => {
  const h = healHarness({ rotatedIds: new Set(["old-id"]), healTo: "new-id", isRead: false });
  await assert.rejects(
    () => withActionRotationHeal("saveEvents", h.attempt, h.deps),
    (error: unknown) =>
      error instanceof ActionRotatedError &&
      error.actionKey === "saveEvents" &&
      /Nothing was written/.test(error.message) &&
      /rerun the command/.test(error.message),
  );
  assert.deepEqual(h.attempts, ["old-id"], "the write is never replayed");
  assert.equal(h.heals(), 1);
  assert.equal(h.ids.saveEvents, "new-id", "table healed for the rerun");
});

test("a second rotation in the same process is never healed again", async () => {
  const h = healHarness({ rotatedIds: new Set(["old-id"]), healTo: "new-id" });
  await withActionRotationHeal("getEvents", h.attempt, h.deps);
  // Simulate another deploy: the healed id rotates too.
  h.deps.ids.getEvents = "old-id";
  await assert.rejects(
    () => withActionRotationHeal("getEvents", h.attempt, h.deps),
    /after a self-heal in this run\. Refusing a second derivation/,
  );
  assert.equal(h.heals(), 1);
});

test("a raw id not in the table cannot self-heal", async () => {
  const h = healHarness({ rotatedIds: new Set(["raw-id"]), healTo: "new-id" });
  await assert.rejects(
    () => withActionRotationHeal(null, h.attempt, { ...h.deps, rawId: "raw-id" }),
    /cannot self-heal/,
  );
  assert.equal(h.heals(), 0);
});

test("loadActionIds: file overrides fallback, env overrides file, malformed file ids ignored", () => {
  const fromFallback = loadActionIds(null, {});
  assert.equal(fromFallback.source.getEvents, "fallback");
  assert.match(fromFallback.actions.getEvents, /^[0-9a-f]{42}$/);
  assert.equal(fromFallback.build_id, null);

  const file = {
    build_id: "buildX",
    derived_at: "2026-09-16T00:00:00.000Z",
    base_url: "https://new.boostly.com",
    actions: { getEvents: "40" + "ab".repeat(20), saveEvents: "not-hex" },
    sources: {},
  };
  const loaded = loadActionIds(file, { BOOSTLY_SWITCH_ACCOUNT_ACTION_ID: "env-switch", BOOSTLY_ACTION_ID_CREATE_PROMOTION: "env-promo" });
  assert.equal(loaded.actions.getEvents, "40" + "ab".repeat(20));
  assert.equal(loaded.source.getEvents, "action-ids.json");
  assert.equal(loaded.source.saveEvents, "fallback");
  assert.equal(loaded.actions.switchUserAccount, "env-switch");
  assert.equal(loaded.actions.createPromotion, "env-promo");
  assert.equal(loaded.source.createPromotion, "env");
  assert.equal(loaded.build_id, "buildX");
});

test("derive: build id and createServerReference shapes are parsed from HTML and chunks", () => {
  assert.equal(extractBuildId('<script>self.__next_f.push([1,"0:{\\"P\\":null,\\"b\\":\\"4jnFthvfTvoyU7FxoRTm6\\",\\"p\\":\\"\\""])</script>'), "4jnFthvfTvoyU7FxoRTm6");
  assert.equal(extractBuildId('0:{"a":"$@1","f":"","b":"4jnFthvfTvoyU7FxoRTm6"}'), "4jnFthvfTvoyU7FxoRTm6");
  assert.equal(extractBuildId("<html>no flight</html>"), null);
  const js = '(0,r.createServerReference)("40aa" + "", r.callServer, void 0, r.findSourceMapURL, "ignored");'
    + 'createServerReference("40961210cb94faba356ee049f416f26bd24e87fddd",c.callServer,void 0,c.findSourceMapURL,"getTouchpointEventConfigForLocation");'
    + 'x=("606ac60ff64d8f819cbd0c580c9bf8f43e1cb35c96",a.callServer,void 0,a.findSourceMapURL,"updateLocation")';
  const found = scanChunkForActions(js);
  assert.equal(found.get("getTouchpointEventConfigForLocation"), "40961210cb94faba356ee049f416f26bd24e87fddd");
  assert.equal(found.get("updateLocation"), "606ac60ff64d8f819cbd0c580c9bf8f43e1cb35c96");
  assert.equal(fillPage("/in-store/links/location/{locationId}", { locationId: "loc1" }), "/in-store/links/location/loc1");
  assert.equal(fillPage("/in-store/signage/{signageId}?tab=links", { locationId: "loc1", signageId: null }), null);
  assert.equal(fillPage("/account-settings", {}), "/account-settings");
});

test("derive: fake site yields ids per page, one chunk fetch per chunk, missing keys reported", async () => {
  const fetched: string[] = [];
  const page = (chunks: string[]) =>
    `<html>${chunks.map((c) => `<script src="/_next/static/chunks/${c}"></script>`).join("")}<script>self.__next_f.push([1,"0:{\\"b\\":\\"buildZ0123456789\\"}"])</script></html>`;
  const chunkJs: Record<string, string> = {
    "shared-1.js": 'createServerReference("4020718305cec6b1f59e65fdf921a2ae2047ba6ed2",r.callServer,void 0,r.findSourceMapURL,"switchUserAccount")',
    "page-links.js": 'createServerReference("4096121000000000000000000000000000000000dd",r.callServer,void 0,r.findSourceMapURL,"getTouchpointEventConfigForLocation");createServerReference("408b29d700000000000000000000000000000000ff",r.callServer,void 0,r.findSourceMapURL,"saveLocationTouchpointEventConfigs")',
    "page-acct.js": 'createServerReference("4039198c00000000000000000000000000000000aa",r.callServer,void 0,r.findSourceMapURL,"updateAccountBranding")',
  };
  const fakeFetch = async (url: string, init?: RequestInit) => {
    fetched.push(url);
    assert.equal(new Headers(init?.headers).get("Cookie"), "s=1");
    const path = url.replace("https://fake.test", "");
    if (path.startsWith("/_next/static/chunks/")) {
      const body = chunkJs[path.split("/").pop() ?? ""];
      return new Response(body ?? "", { status: body ? 200 : 404 });
    }
    if (path === "/in-store/links/location/loc1") return new Response(page(["shared-1.js", "page-links.js"]), { status: 200 });
    if (path === "/account-settings") return new Response(page(["shared-1.js", "page-acct.js"]), { status: 200 });
    if (path === "/locations/loc1") return new Response("<html>This page could not be found.</html>", { status: 404 });
    return new Response("", { status: 404 });
  };
  const result = await deriveActionIds({
    cookie: "Cookie: s=1",
    baseUrl: "https://fake.test/",
    fetchImpl: fakeFetch as typeof fetch,
    sampleIds: { locationId: "loc1", signageId: null, objectiveId: null },
    only: ["getEvents", "saveEvents", "updateAccountBranding", "switchUserAccount", "updateLocation", "saveTouchpointEventOverrides"],
  });
  assert.equal(result.build_id, "buildZ0123456789");
  assert.equal(result.actions.getEvents, "4096121000000000000000000000000000000000dd");
  assert.equal(result.actions.saveEvents, "408b29d700000000000000000000000000000000ff");
  assert.equal(result.actions.updateAccountBranding, "4039198c00000000000000000000000000000000aa");
  assert.equal(result.actions.switchUserAccount, "4020718305cec6b1f59e65fdf921a2ae2047ba6ed2");
  assert.deepEqual(result.sources.getEvents, { export: "getTouchpointEventConfigForLocation", page: "/in-store/links/location/loc1", chunk: "page-links.js" });
  // saveTouchpointEventOverrides has no signage id; updateLocation's page 404'd.
  assert.deepEqual([...result.missing].sort(), ["saveTouchpointEventOverrides", "updateLocation"]);
  assert.equal(fetched.filter((u) => u.endsWith("shared-1.js")).length, 1, "chunk cache");

  const changes = diffActionIds({ getEvents: "old", switchUserAccount: "4020718305cec6b1f59e65fdf921a2ae2047ba6ed2" }, result.actions);
  assert.deepEqual(changes.map((c) => c.key).sort(), ["getEvents", "saveEvents", "updateAccountBranding"]);
  const merged = mergeActionIdsFile(
    { build_id: "buildY", derived_at: "x", base_url: "https://fake.test", actions: { updateLocation: "kept" }, sources: {} },
    result,
    "https://fake.test",
    new Date("2026-09-16T12:00:00Z"),
  );
  assert.equal(merged.build_id, "buildZ0123456789");
  assert.equal(merged.derived_at, "2026-09-16T12:00:00.000Z");
  assert.equal(merged.actions.updateLocation, "kept", "unreachable keys keep their previous id");
  assert.equal(merged.actions.getEvents, "4096121000000000000000000000000000000000dd");
});

// ---------------------------------------------------------------------------
// fulfillment commands
// ---------------------------------------------------------------------------
import {
  assertFulfillmentPageMatches,
  flightString,
  fulfillmentState,
  normalizeFulfillmentPage,
  parseShipToInput,
  planFulfillmentWrite,
  runFulfillmentCommand,
  type FulfillmentDbMeta,
  type FulfillmentDeps,
  type FulfillmentRequestPage,
} from "./boostly-links.ts";

const fulfillmentPage = (over: Partial<FulfillmentRequestPage> = {}): FulfillmentRequestPage => ({
  id: "req1",
  order_type: "full_order",
  digital_fulfilled_at: "2026-09-16T22:38:13.742Z",
  store_details_confirmed_at: null,
  offer_promotion_id: null,
  offer_text: "Enjoyed your meal?",
  notes: null,
  canceled_at: null,
  tracking_number: null,
  tracking_status: null,
  shipping_recipient_name: "Pat Owner",
  shipping_address_line1: "1 Main St",
  shipping_address_line2: null,
  shipping_city: "Manchester",
  shipping_state: "NH",
  shipping_zip: "03101",
  location: { id: "loc1", name: "Olympus Pizza (Manchester)", address: null },
  account: { id: "acct1", name: "Olympus" },
  items: [
    { id: "i1", item_type: "tapcards", placement: null, focus: null, quantity: 10, printed_at: null },
    { id: "i2", item_type: "signage", placement: "point_of_purchase", focus: null, quantity: 1, printed_at: null },
    { id: "i3", item_type: "stickers", placement: "table", focus: "review", quantity: 10, printed_at: null },
  ],
  offerOptions: [{ value: "p1", label: "20% OFF" }],
  state: "store_details",
  ...over,
});
const fulfillmentMeta = (over: Partial<FulfillmentDbMeta> = {}): FulfillmentDbMeta => ({
  id: "req1",
  location_id: "loc1",
  location_name: "Olympus Pizza (Manchester)",
  physical_fulfillment_notified_at: null,
  has_slack_thread: true,
  offer_text: "Enjoyed your meal?",
  store_details_confirmed_at: null,
  digital_fulfilled_at: "2026-09-16T22:38:13.742Z",
  ...over,
});

test("fulfillment: flight page is normalized ($D dates, $$ escapes)", () => {
  const page = normalizeFulfillmentPage({
    ...fulfillmentPage(),
    store_details_confirmed_at: "$D2026-09-16T19:05:38.671Z",
    offer_text: "$$10 OFF",
    offerOptions: [{ value: "p", label: "$$5 OFF $25+" }],
    items: [{ id: "i", item_type: "signage", placement: null, focus: null, quantity: 1, printed_at: "$D2026-09-01T00:00:00.000Z" }],
  });
  assert.equal(page.store_details_confirmed_at, "2026-09-16T19:05:38.671Z");
  assert.equal(page.offer_text, "$10 OFF");
  assert.equal(page.offerOptions[0].label, "$5 OFF $25+");
  assert.equal(page.items[0].printed_at, "2026-09-01T00:00:00.000Z");
  assert.equal(flightString("plain"), "plain");
});

test("fulfillment: state port mirrors src/lib/fulfillment/status.ts", () => {
  assert.equal(fulfillmentState(fulfillmentPage({ digital_fulfilled_at: null })), "digital_fulfillment");
  assert.equal(fulfillmentState(fulfillmentPage()), "store_details");
  assert.equal(fulfillmentState(fulfillmentPage({ store_details_confirmed_at: "x", shipping_zip: "" })), "store_details");
  assert.equal(fulfillmentState(fulfillmentPage({ store_details_confirmed_at: "x" })), "physical_fulfillment");
  const printed = fulfillmentPage({ store_details_confirmed_at: "x" });
  printed.items = printed.items.map((i) => ({ ...i, printed_at: "y" }));
  assert.equal(fulfillmentState(printed), "printing_label");
  assert.equal(fulfillmentState(fulfillmentPage({ canceled_at: "z" })), "canceled");
  assert.equal(fulfillmentState(fulfillmentPage({ tracking_number: "1Z", tracking_status: "in_transit" })), "shipping");
  assert.equal(fulfillmentState(fulfillmentPage({ tracking_number: "1Z" })), "delivered");
  // tapcards-only boxes need no offer
  assert.equal(
    fulfillmentState(fulfillmentPage({ store_details_confirmed_at: "x", offer_text: "", items: [{ id: "i1", item_type: "tapcards", placement: null, focus: null, quantity: 10, printed_at: null }] })),
    "physical_fulfillment",
  );
});

test("fulfillment: store-details --confirm plan shows before/after, physical entry, and the Slack ping", () => {
  const plan = planFulfillmentWrite(fulfillmentPage(), "store-details", { confirmed: true }, fulfillmentMeta());
  assert.equal(plan.action, "setStoreDetailsConfirmed");
  assert.deepEqual(plan.args, ["req1", true]);
  assert.deepEqual(plan.before, { store_details_confirmed_at: null });
  assert.equal(plan.after.store_details_confirmed_at, "<server timestamp at apply>");
  assert.equal(plan.state_before, "store_details");
  assert.equal(plan.state_after, "physical_fulfillment");
  assert.equal(plan.enters_physical_fulfillment, true);
  assert.equal(plan.slack_ping.expected, true);
  assert.equal(plan.slack_ping.threaded, true);
  assert.equal(plan.noop, false);
  assert.equal(plan.refusal, null);
});

test("fulfillment: already-pinged request does not ping again; unknown DB -> unknown", () => {
  const pinged = planFulfillmentWrite(fulfillmentPage(), "store-details", { confirmed: true }, fulfillmentMeta({ physical_fulfillment_notified_at: "2026-09-10T00:00:00Z" }));
  assert.equal(pinged.slack_ping.expected, false);
  const unknown = planFulfillmentWrite(fulfillmentPage(), "store-details", { confirmed: true }, null);
  assert.equal(unknown.slack_ping.expected, "unknown");
});

test("fulfillment: --unconfirm regresses out of physical fulfillment with no ping; noop is detected", () => {
  const ready = fulfillmentPage({ store_details_confirmed_at: "2026-09-16T00:00:00Z" });
  const plan = planFulfillmentWrite(ready, "store-details", { confirmed: false }, fulfillmentMeta());
  assert.deepEqual(plan.args, ["req1", false]);
  assert.equal(plan.state_before, "physical_fulfillment");
  assert.equal(plan.state_after, "store_details");
  assert.equal(plan.slack_ping.expected, false);
  const noop = planFulfillmentWrite(ready, "store-details", { confirmed: true }, fulfillmentMeta());
  assert.equal(noop.noop, true);
  // a no-op save on an un-pinged ready request still fires the check
  assert.equal(noop.slack_ping.expected, true);
  assert.match(noop.slack_ping.reason, /even a no-op/);
});

test("fulfillment: confirm without usable store details mirrors the server refusal", () => {
  const plan = planFulfillmentWrite(fulfillmentPage({ shipping_address_line1: null }), "store-details", { confirmed: true }, fulfillmentMeta());
  assert.match(plan.refusal ?? "", /Add a ship-to address/);
  assert.equal(plan.slack_ping.expected, false);
  const canceled = planFulfillmentWrite(fulfillmentPage({ canceled_at: "x" }), "branding", { completed: true }, fulfillmentMeta());
  assert.match(canceled.refusal ?? "", /canceled/);
});

test("fulfillment: branding --complete/--incomplete argument shape and state", () => {
  const page = fulfillmentPage({ digital_fulfilled_at: null, store_details_confirmed_at: "x" });
  const complete = planFulfillmentWrite(page, "branding", { completed: true }, fulfillmentMeta());
  assert.equal(complete.action, "setDigitalFulfillmentCompleted");
  assert.deepEqual(complete.args, ["req1", true]);
  assert.equal(complete.state_before, "digital_fulfillment");
  assert.equal(complete.state_after, "physical_fulfillment");
  assert.equal(complete.enters_physical_fulfillment, true);
  assert.equal(complete.slack_ping.expected, true);
  const incomplete = planFulfillmentWrite(fulfillmentPage(), "branding", { completed: false }, fulfillmentMeta());
  assert.deepEqual(incomplete.args, ["req1", false]);
  assert.deepEqual(incomplete.before, { digital_fulfilled_at: "2026-09-16T22:38:13.742Z" });
  assert.deepEqual(incomplete.after, { digital_fulfilled_at: null });
  assert.equal(incomplete.state_after, "digital_fulfillment");
  assert.equal(incomplete.slack_ping.expected, false);
});

test("fulfillment: offer plan trims text, nulls promotion_id, reopens printed offer-bearing items", () => {
  const page = fulfillmentPage({ store_details_confirmed_at: "x", offer_promotion_id: "p1", offer_text: "20% OFF" });
  page.items = page.items.map((i) => ({ ...i, printed_at: "2026-09-01T00:00:00Z" }));
  const plan = planFulfillmentWrite(page, "offer", { text: "  20% Off " }, fulfillmentMeta({ physical_fulfillment_notified_at: "2026-09-01T00:00:00Z" }));
  assert.equal(plan.action, "updateFulfillmentOffer");
  assert.deepEqual(plan.args, ["req1", { promotion_id: null, text: "20% Off" }]);
  assert.deepEqual(plan.before, { offer_text: "20% OFF", offer_promotion_id: "p1" });
  assert.deepEqual(plan.after, { offer_text: "20% Off", offer_promotion_id: null });
  assert.equal(plan.reopens_prints, 2, "signage + stickers reopen; tapcards keep printed_at");
  assert.equal(plan.state_before, "printing_label");
  assert.equal(plan.state_after, "physical_fulfillment");
  assert.equal(plan.slack_ping.expected, false, "stamp already set: unprint does not reset it");
  assert.equal(planFulfillmentWrite(fulfillmentPage(), "offer", { text: "Enjoyed your meal?" }, fulfillmentMeta()).noop, true);
  assert.throws(() => planFulfillmentWrite(fulfillmentPage(), "offer", { text: "  " }, null), /Offer is required/);
  assert.throws(() => planFulfillmentWrite(fulfillmentPage(), "offer", { text: "x".repeat(201) }, null), /200 characters/);
  assert.match(planFulfillmentWrite(fulfillmentPage({ tracking_number: "1Z" }), "offer", { text: "20% Off" }, null).refusal ?? "", /after shipping/);
});

test("fulfillment: page/DB mismatch refuses with exit 6", () => {
  assert.throws(() => assertFulfillmentPageMatches(fulfillmentPage(), "other", fulfillmentMeta()), (e: Error & { exitCode?: number }) => e.exitCode === 6 && /is for req1, not other/.test(e.message));
  assert.throws(() => assertFulfillmentPageMatches(fulfillmentPage(), "req1", fulfillmentMeta({ location_id: "loc2" })), (e: Error & { exitCode?: number }) => e.exitCode === 6 && /page\/DB mismatch/.test(e.message));
  assert.throws(() => assertFulfillmentPageMatches(fulfillmentPage(), "req1", fulfillmentMeta({ location_name: "Someone Else" })), /mismatch/);
  assert.doesNotThrow(() => assertFulfillmentPageMatches(fulfillmentPage(), "req1", fulfillmentMeta()));
  assert.doesNotThrow(() => assertFulfillmentPageMatches(fulfillmentPage(), "req1", null));
});

function fulfillmentHarness(opts: {
  page: FulfillmentRequestPage;
  meta?: FulfillmentDbMeta | null | Error;
  afterWrite?: (page: FulfillmentRequestPage, action: string, args: unknown[]) => FulfillmentRequestPage;
  result?: { success: true } | { success: false; error: string };
}) {
  let current = opts.page;
  const calls: { action: string; args: unknown[] }[] = [];
  const logs: string[] = [];
  let fetches = 0;
  let metaReads = 0;
  const deps: FulfillmentDeps = {
    fetchPage: async () => { fetches += 1; return current; },
    dbMeta: async () => {
      metaReads += 1;
      if (opts.meta instanceof Error) throw opts.meta;
      const meta = opts.meta === undefined ? fulfillmentMeta() : opts.meta;
      // after a ping, the stamp becomes visible on the second read
      return meta && calls.length && metaReads > 1 ? { ...meta, physical_fulfillment_notified_at: meta.physical_fulfillment_notified_at ?? "2026-09-16T23:00:00Z" } : meta;
    },
    callAction: async (_id, action, args) => {
      calls.push({ action, args });
      if (opts.afterWrite) current = opts.afterWrite(current, action, args);
      return opts.result ?? { success: true };
    },
    log: (line) => logs.push(line),
    sleep: async () => {},
  };
  return { deps, calls, logs, fetches: () => fetches };
}

test("fulfillment get returns the summary without calling any action", async () => {
  const h = fulfillmentHarness({ page: fulfillmentPage() });
  const out = await runFulfillmentCommand({ json: true }, "get", "req1", h.deps);
  assert.equal(out.id, "req1");
  assert.equal(out.state, "store_details");
  assert.equal(out.offer_text, "Enjoyed your meal?");
  assert.equal(out.physical_fulfillment_notified_at, null);
  assert.deepEqual(out.location, { id: "loc1", name: "Olympus Pizza (Manchester)" });
  assert.equal(h.calls.length, 0);
});

test("fulfillment offer dry-run prints exact before/after and writes nothing", async () => {
  const h = fulfillmentHarness({ page: fulfillmentPage() });
  const out = await runFulfillmentCommand({ text: "20% Off" }, "offer", "req1", h.deps);
  assert.equal(out.dry_run, true);
  assert.equal(out.action, "updateFulfillmentOffer");
  assert.deepEqual(out.args, ["req1", { promotion_id: null, text: "20% Off" }]);
  assert.deepEqual(out.before, { offer_text: "Enjoyed your meal?", offer_promotion_id: null });
  assert.deepEqual(out.after, { offer_text: "20% Off", offer_promotion_id: null });
  assert.equal(out.state_before, "store_details");
  assert.equal(out.state_after, "store_details");
  assert.equal(out.enters_physical_fulfillment, false);
  assert.deepEqual((out.slack_ping as { expected: boolean }).expected, false);
  assert.equal(h.calls.length, 0);
});

test("fulfillment store-details --confirm dry-run predicts physical fulfillment + Slack; --apply warns, writes, reads back", async () => {
  const h = fulfillmentHarness({
    page: fulfillmentPage(),
    afterWrite: (page, action, args) =>
      action === "setStoreDetailsConfirmed" ? { ...page, store_details_confirmed_at: args[1] ? "2026-09-16T23:00:00Z" : null, state: "physical_fulfillment" } : page,
  });
  const dry = await runFulfillmentCommand({ confirm: true }, "store-details", "req1", h.deps);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.enters_physical_fulfillment, true);
  assert.equal((dry.slack_ping as { expected: boolean }).expected, true);
  assert.equal(h.calls.length, 0);

  const applied = await runFulfillmentCommand({ confirm: true, apply: true }, "store-details", "req1", h.deps);
  assert.deepEqual(h.calls, [{ action: "setStoreDetailsConfirmed", args: ["req1", true] }]);
  assert.equal(applied.applied, true);
  assert.equal(applied.readback_ok, true);
  assert.equal((applied.readback as { store_details_confirmed_at: string }).store_details_confirmed_at, "2026-09-16T23:00:00Z");
  assert.equal((applied.slack_ping_observed as { physical_fulfillment_notified_at: string }).physical_fulfillment_notified_at, "2026-09-16T23:00:00Z");
  assert.ok(h.logs.some((l) => /WARNING: this write moves Olympus Pizza \(Manchester\) \(req1\) in physical_fulfillment.*Slack ping/.test(l)), h.logs.join("\n"));
});

test("fulfillment --apply refuses on page/DB mismatch before calling the action", async () => {
  const h = fulfillmentHarness({ page: fulfillmentPage(), meta: fulfillmentMeta({ location_name: "Wrong Place" }) });
  await assert.rejects(
    runFulfillmentCommand({ confirm: true, apply: true }, "store-details", "req1", h.deps),
    (e: Error & { exitCode?: number }) => e.exitCode === 6 && /mismatch/.test(e.message),
  );
  assert.equal(h.calls.length, 0);
  const wrongId = fulfillmentHarness({ page: fulfillmentPage({ id: "req2" }) });
  await assert.rejects(runFulfillmentCommand({ text: "x" }, "offer", "req1", wrongId.deps), /is for req2, not req1/);
  assert.equal(wrongId.calls.length, 0);
});

test("fulfillment --apply refuses when the DB cross-check is unavailable; dry-run degrades with a warning", async () => {
  const h = fulfillmentHarness({ page: fulfillmentPage(), meta: new Error("v2-db down") });
  const dry = await runFulfillmentCommand({ text: "20% Off" }, "offer", "req1", h.deps);
  assert.equal(dry.dry_run, true);
  assert.ok(h.logs.some((l) => /V2 DB unavailable/.test(l)));
  await assert.rejects(runFulfillmentCommand({ text: "20% Off", apply: true }, "offer", "req1", h.deps), /Refusing --apply: the V2 DB cross-check/);
  assert.equal(h.calls.length, 0);
});

test("fulfillment noop and server-refusal paths never call the action; server error surfaces", async () => {
  const noop = fulfillmentHarness({ page: fulfillmentPage() });
  const out = await runFulfillmentCommand({ text: "Enjoyed your meal?", apply: true }, "offer", "req1", noop.deps);
  assert.equal(out.noop, true);
  assert.match(String(out.skipped), /no change/);
  assert.equal(noop.calls.length, 0);

  const canceled = fulfillmentHarness({ page: fulfillmentPage({ canceled_at: "x" }) });
  await assert.rejects(runFulfillmentCommand({ complete: true, apply: true }, "branding", "req1", canceled.deps), /Refusing \(server rule\): Cannot modify a canceled/);
  assert.equal(canceled.calls.length, 0);

  const rejected = fulfillmentHarness({ page: fulfillmentPage(), result: { success: false, error: "The selected offer is not available for this location" } });
  await assert.rejects(runFulfillmentCommand({ text: "20% Off", apply: true }, "offer", "req1", rejected.deps), /rejected the write: The selected offer/);

  const stale = fulfillmentHarness({ page: fulfillmentPage() }); // write "succeeds" but readback unchanged
  const origLog = console.log; console.log = () => {};
  try {
    await assert.rejects(runFulfillmentCommand({ text: "20% Off", apply: true }, "offer", "req1", stale.deps), /Readback after apply does not show/);
  } finally { console.log = origLog; }
});

test("fulfillment flag validation", async () => {
  const h = fulfillmentHarness({ page: fulfillmentPage() });
  await assert.rejects(runFulfillmentCommand({}, "store-details", "req1", h.deps), /exactly one of --confirm or --unconfirm/);
  await assert.rejects(runFulfillmentCommand({ confirm: true, unconfirm: true }, "store-details", "req1", h.deps), /exactly one/);
  await assert.rejects(runFulfillmentCommand({}, "branding", "req1", h.deps), /exactly one of --complete or --incomplete/);
  await assert.rejects(runFulfillmentCommand({}, "offer", "req1", h.deps), /Offer is required/);
  await assert.rejects(runFulfillmentCommand({}, "bogus", "req1", h.deps), /Unknown fulfillment command/);
});

test("derive: fulfillment request page specs fill from requestId and are admin-scoped", () => {
  assert.equal(fillPage("/admin/fulfillment/{requestId}", { requestId: "bnlr" }), "/admin/fulfillment/bnlr");
  assert.equal(fillPage("/admin/fulfillment/{requestId}", { locationId: "loc1", requestId: null }), null);
});

test("fulfillment ship-to: input parsing mirrors shippingAddressInputSchema", () => {
  assert.deepEqual(
    parseShipToInput({ recipient: " Riyadh Gazali ", line1: "533 Nostrand Ave", city: "Brooklyn", state: "ny", zip: "11216", line2: " " }),
    { shipping_recipient_name: "Riyadh Gazali", shipping_address_line1: "533 Nostrand Ave", shipping_address_line2: null, shipping_city: "Brooklyn", shipping_state: "NY", shipping_zip: "11216" },
  );
  assert.throws(() => parseShipToInput({ recipient: "x", line1: "y", city: "z", state: "New York", zip: "11216" }), /2-letter/);
  assert.throws(() => parseShipToInput({ recipient: "x", line1: "y", city: "z", state: "NY", zip: "1121" }), /valid ZIP/);
  assert.throws(() => parseShipToInput({ line1: "y", city: "z", state: "NY", zip: "11216" }), /--recipient is required/);
});

test("fulfillment ship-to: plan writes the location ship-to, keeps stamps, and can unblock store details", async () => {
  const noAddr = fulfillmentPage({ shipping_recipient_name: null, shipping_address_line1: null, shipping_city: null, shipping_state: null, shipping_zip: null, store_details_confirmed_at: "2026-08-27T00:00:00Z", digital_fulfilled_at: null });
  const shipTo = parseShipToInput({ recipient: "Riyadh Gazali", line1: "533 Nostrand Ave", city: "Brooklyn", state: "NY", zip: "11216" });
  const plan = planFulfillmentWrite(noAddr, "ship-to", { shipTo }, fulfillmentMeta());
  assert.equal(plan.action, "updateShippingAddress");
  assert.deepEqual(plan.args, ["req1", shipTo]);
  assert.equal(plan.before.shipping_address_line1, null);
  assert.equal(plan.after.shipping_city, "Brooklyn");
  assert.equal(plan.state_before, "digital_fulfillment");
  assert.equal(plan.state_after, "digital_fulfillment", "branding still open");
  assert.equal(plan.slack_ping.expected, false);
  // with branding done, the address alone completes store details -> physical
  const brandingDone = { ...noAddr, digital_fulfilled_at: "2026-09-16T00:00:00Z" };
  const plan2 = planFulfillmentWrite(brandingDone, "ship-to", { shipTo }, fulfillmentMeta());
  assert.equal(plan2.state_before, "store_details");
  assert.equal(plan2.state_after, "physical_fulfillment");
  assert.equal(plan2.slack_ping.expected, true);
  assert.equal(planFulfillmentWrite({ ...noAddr, ...shipTo }, "ship-to", { shipTo }, fulfillmentMeta()).noop, true);

  const h = fulfillmentHarness({
    page: noAddr,
    afterWrite: (page, action, args) => (action === "updateShippingAddress" ? { ...page, ...(args[1] as object) } : page),
  });
  const opts = { recipient: "Riyadh Gazali", line1: "533 Nostrand Ave", city: "Brooklyn", state: "NY", zip: "11216" };
  const dry = await runFulfillmentCommand(opts, "ship-to", "req1", h.deps);
  assert.equal(dry.dry_run, true);
  assert.equal(h.calls.length, 0);
  const applied = await runFulfillmentCommand({ ...opts, apply: true }, "ship-to", "req1", h.deps);
  assert.deepEqual(h.calls, [{ action: "updateShippingAddress", args: ["req1", shipTo] }]);
  assert.equal(applied.readback_ok, true);
  assert.equal((applied.readback as { shipping_zip: string }).shipping_zip, "11216");
  await assert.rejects(runFulfillmentCommand({ recipient: "x" }, "ship-to", "req1", h.deps), /is required for ship-to/);
});

test("subscribe-link form replay mirrors the edit form and applies only requested changes", async () => {
  const { buildSubscribeLinkFormData, normalizeSubscribeLinkPage, subscribeLinkDrift } = await import("./boostly-links.ts");
  const page = normalizeSubscribeLinkPage({
    id: "sl1", account_id: "acc", location_id: "loc", name: "Text Club - X", attribution_source: "touchpoint",
    promotion_text: "20% off your next order", promotion_subtext: null, promotion_attachment_id: null, logo_attachment_id: null,
    keyword: { id: "kw1", keyword: "SUBSCRIBE_ABC", promotion_id: "p20", response_message: "Hi {offer_link} Reply STOP to END", attachment_id: null, offer_expires_in_days: 14, redemption_timer_minutes: null },
  });
  const form = buildSubscribeLinkFormData(page, { promotion_text: "10% off orders of $30 or more", promotion_id: "p10" });
  assert.equal(form.promotion_text, "10% off orders of $30 or more");
  assert.equal(form.promotion_id, "p10");
  assert.equal(form.name, "Text Club - X");
  assert.equal(form.location_id, "loc");
  assert.equal(form.offer_expires_in_days, 14);
  assert.equal(form.redemption_timer_minutes, null);
  assert.equal(form.promotion_subtext, "");
  assert.equal(form.attachment_file, null);
  assert.equal(form.attachment_id, undefined);
  // Text-only change keeps the keyword's promotion.
  assert.equal(buildSubscribeLinkFormData(page, { promotion_text: "x" }).promotion_id, "p20");
  assert.throws(() => buildSubscribeLinkFormData(page, { promotion_text: "  " }), /must not be empty/);
  assert.throws(() => buildSubscribeLinkFormData({ ...page, keyword: { ...page.keyword, response_message: "no opt out" } }, { promotion_text: "x" }), /opt-out/);
  const after = { ...page, promotion_text: "changed", keyword: { ...page.keyword, offer_expires_in_days: 7 } };
  assert.deepEqual(subscribeLinkDrift(page, after), ["keyword.offer_expires_in_days"]);
});

test("fulfillment note: --append keeps existing notes, --set replaces, schema limits mirror fulfillmentNotesSchema", async () => {
  const { composeFulfillmentNotes } = await import("./boostly-links.ts");
  assert.equal(composeFulfillmentNotes(null, { append: "Figma signage: https://x/y" }), "Figma signage: https://x/y");
  assert.equal(composeFulfillmentNotes("Existing line ", { append: "Figma signage: https://x/y" }), "Existing line\nFigma signage: https://x/y");
  assert.equal(composeFulfillmentNotes("old", { set: "new" }), "new");
  assert.equal(composeFulfillmentNotes("old", { set: "  " }), null, "blank -> null like the action");
  assert.throws(() => composeFulfillmentNotes("old", {}), /exactly one of --set/);
  assert.throws(() => composeFulfillmentNotes("old", { set: "a", append: "b" }), /exactly one of --set/);
  assert.throws(() => composeFulfillmentNotes("x".repeat(1995), { append: "123456" }), /2000 characters/);

  const page = fulfillmentPage({ notes: "Call facts: none" });
  const plan = planFulfillmentWrite(page, "note", { notes: "Call facts: none\nFigma signage: https://x/y" }, fulfillmentMeta());
  assert.equal(plan.action, "updateFulfillmentNotes");
  assert.deepEqual(plan.args, ["req1", "Call facts: none\nFigma signage: https://x/y"]);
  assert.deepEqual(plan.before, { notes: "Call facts: none" });
  assert.equal(plan.state_before, "store_details");
  assert.equal(plan.state_after, "store_details", "notes never change the state");
  assert.equal(plan.slack_ping.expected, false);
  assert.equal(planFulfillmentWrite(page, "note", { notes: "Call facts: none" }, fulfillmentMeta()).noop, true);
  // a ready-but-unpinged request pings on ANY save, notes included
  const ready = fulfillmentPage({ store_details_confirmed_at: "2026-09-16T00:00:00Z", notes: null });
  assert.equal(planFulfillmentWrite(ready, "note", { notes: "x" }, fulfillmentMeta()).slack_ping.expected, true);
  assert.match(planFulfillmentWrite(fulfillmentPage({ canceled_at: "z" }), "note", { notes: "x" }, fulfillmentMeta()).refusal ?? "", /canceled/);

  const h = fulfillmentHarness({
    page,
    afterWrite: (p, action, args) => (action === "updateFulfillmentNotes" ? { ...p, notes: (args[1] as string) || null } : p),
  });
  const dry = await runFulfillmentCommand({ append: "Figma signage: https://x/y" }, "note", "req1", h.deps);
  assert.equal(dry.dry_run, true);
  assert.equal(h.calls.length, 0);
  const applied = await runFulfillmentCommand({ append: "Figma signage: https://x/y", apply: true }, "note", "req1", h.deps);
  assert.deepEqual(h.calls, [{ action: "updateFulfillmentNotes", args: ["req1", "Call facts: none\nFigma signage: https://x/y"] }]);
  assert.equal(applied.readback_ok, true);
  assert.equal((applied.readback as { notes: string }).notes, "Call facts: none\nFigma signage: https://x/y");
  await assert.rejects(runFulfillmentCommand({}, "note", "req1", h.deps), /exactly one of --set/);
});
