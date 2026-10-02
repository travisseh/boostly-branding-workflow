import assert from "node:assert/strict";
import test from "node:test";
import { prepareSocialSave, runSocialSave } from "./boostly-links.ts";

type State = Parameters<typeof prepareSocialSave>[0];
const url = "https://www.facebook.com/example";
const options = { "facebook-url": url };
function fixture(scope: "account" | "location" = "location"): State {
  const account = {
    facebook_url: null, instagram_url: null, x_url: null, tiktok_url: null, youtube_url: null,
    apple_app_url: "https://apps.apple.com/example", google_app_url: null,
    web_primary_color: "#123456", web_secondary_color: "#ABCDEF", web_text_color: "#FFFFFF",
    print_primary_color: "#123456", print_secondary_color: "#ABCDEF", print_text_color: "#FFFFFF",
    print_text_secondary_color: "#FFFFFF", logo_attachment_id: "account-logo", logo_url: null,
  };
  return {
    account, override: null, effective: { ...account }, selected_scope: scope, scope_reason: "test",
    context: { location_id: "loc", location_name: "Restaurant", account_id: "acct", account_name: "Account",
      location_status: "enabled", is_general: false, write_location_count: 1, write_locations: [{ id: "loc", name: "Restaurant", status: "enabled" }] },
    location: { id: "loc", account_id: "acct", name: "Restaurant", address: "123 Main", __source: "web-page",
      ordering_phone_number: null, ordering_url: "https://example.com/order", website_url: "https://example.com",
      timezone: "America/Denver", google_place_id: "place", status: "enabled", shipping_recipient_name: "Owner",
      shipping_address_line1: "456 Main", shipping_address_line2: null, shipping_city: "Town", shipping_state: "UT", shipping_zip: "84043" },
  };
}
function harness(initial: State) {
  let state = structuredClone(initial);
  let saves = 0;
  return {
    get saves() { return saves; },
    get state() { return state; },
    deps: {
      read: async () => structuredClone(state),
      session: async () => ({ id: "acct", name: "Account", spoofedAccountId: "acct", selectedAccountId: null }),
      save: async (current: State, after: State["account"]) => {
        saves++;
        if (current.selected_scope === "account") state.account = { ...after };
        else state.override = { ...after };
        state.effective = Object.fromEntries(Object.keys(state.account).map(key => [key,
          state.override?.[key as keyof State["account"]] ?? state.account[key as keyof State["account"]],
        ])) as State["account"];
        return { success: true };
      },
    },
  };
}
for (const scope of ["account", "location"] as const) {
  test(`${scope} save fills missing social and preserves logo, colors, apps, inheritance and shipping`, async () => {
    const h = harness(fixture(scope));
    const preview = await runSocialSave(options, h.deps);
    assert.equal(h.saves, 0);
    const result = await runSocialSave({ ...options, apply: true, "expected-state-hash": preview.state_hash }, h.deps);
    assert("preserved_settings_verified" in result);
    assert.equal(result.preserved_settings_verified, true);
    assert.equal(h.saves, 1);
    assert.equal(h.state.effective.facebook_url, url);
    assert.equal(h.state.effective.logo_attachment_id, "account-logo");
    assert.equal(h.state.effective.web_primary_color, "#123456");
    assert.equal(h.state.effective.apple_app_url, "https://apps.apple.com/example");
    if (scope === "location") assert.equal(h.state.override?.logo_attachment_id, null);
  });
}
test("existing matching inherited URL is a no-op, conflicting inherited URL aborts", async () => {
  const state = fixture();
  state.account.facebook_url = state.effective.facebook_url = url;
  const h = harness(state);
  const p = await runSocialSave(options, h.deps);
  await runSocialSave({ ...options, apply: true, "expected-state-hash": p.state_hash }, h.deps);
  assert.equal(h.saves, 0);
  assert.equal(h.state.override, null);
  await assert.rejects(runSocialSave({ "facebook-url": "https://facebook.com/other" }, h.deps), /different URL/);
});
test("location save preserves an existing distinct logo and color override", async () => {
  const state = fixture();
  state.override = Object.fromEntries(Object.keys(state.account).map(key => [key, null])) as State["account"];
  state.override.logo_attachment_id = "location-logo";
  state.override.web_primary_color = "#987654";
  state.location.overrideBranding = state.override;
  state.effective = { ...state.account, logo_attachment_id: "location-logo", web_primary_color: "#987654" };
  const h = harness(state);
  const p = await runSocialSave(options, h.deps);
  await runSocialSave({ ...options, apply: true, "expected-state-hash": p.state_hash }, h.deps);
  assert.equal(h.state.override?.logo_attachment_id, "location-logo");
  assert.equal(h.state.override?.web_primary_color, "#987654");
  assert.deepEqual(h.state.account, state.account);
});
test("apply requires preview; rejects stale preview, changed URL intent and pre-save drift", async () => {
  const h = harness(fixture());
  await assert.rejects(runSocialSave({ ...options, apply: true }, h.deps), /requires --expected/);
  const p = await runSocialSave(options, h.deps);
  const apply = { ...options, apply: true, "expected-state-hash": p.state_hash };
  await assert.rejects(runSocialSave({ ...apply, "facebook-url": "https://facebook.com/other" }, h.deps), /changed since preview/);
  h.state.account.logo_attachment_id = "new-logo";
  await assert.rejects(runSocialSave(apply, h.deps), /changed since preview/);
  const fresh = harness(fixture());
  let reads = 0;
  await assert.rejects(runSocialSave(apply, { ...fresh.deps, read: async () => {
    const state = await fresh.deps.read();
    if (++reads === 2) state.location.shipping_city = "Changed";
    return state;
  } }), /changed before save/);
  assert.equal(h.saves + fresh.saves, 0);
});
test("readback detects unrelated branding or shipping mutation and failed writes", async () => {
  for (const field of ["branding", "shipping", "failure"]) {
    const h = harness(fixture());
    const p = await runSocialSave(options, h.deps);
    await assert.rejects(runSocialSave({ ...options, apply: true, "expected-state-hash": p.state_hash }, {
      ...h.deps, save: async (state, after) => {
        if (field === "failure") return { success: false };
        await h.deps.save(state, after);
        if (field === "branding") h.state.account.web_primary_color = "#000000";
        else h.state.location.shipping_city = "Changed";
        return { success: true };
      },
    }));
  }
});
test("rejects unsafe form normalization and wrong session without a write", async () => {
  const account = fixture("account");
  account.account.print_text_secondary_color = null;
  assert.throws(() => prepareSocialSave(account, options), /would normalize/);
  const location = fixture();
  location.override = { ...location.account };
  assert.throws(() => prepareSocialSave(location, options), /redundant override/);
  const h = harness(fixture());
  await assert.rejects(runSocialSave(options, { ...h.deps,
    session: async () => ({ id: "other", name: null, spoofedAccountId: null, selectedAccountId: null }),
  }), /does not match target/);
  assert.equal(h.saves, 0);
});
