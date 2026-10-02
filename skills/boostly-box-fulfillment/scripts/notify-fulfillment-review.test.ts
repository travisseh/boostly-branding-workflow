import assert from "node:assert/strict";
import test from "node:test";

import { buildFulfillmentPlan } from "./fulfillment-plan.ts";
import { reviewNotificationMessage, reviewNotifications } from "./notify-fulfillment-review.ts";

test("security challenges create one concise notification and never include unrelated holds", () => {
  const plan = buildFulfillmentPlan({
    request: { request_key: "my-pie|holladay", canonical_thread_ts: "3.0", badge_quantity: null, badge_quantity_status: "missing" },
    location: {
      location_id: "loc_my_pie",
      location_name: "My Pie Holladay",
      account_id: "acct_my_pie",
      account_name: "My Pie",
      website_url: "https://pizzayourway.com",
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: {
      category_results: [
        { category: "ordering", category_status: "needs_manual_review", selected_link: { input_url: "https://pizzayourway.com/menu/mypieholladay", validity_evidence: ["security_or_bot_challenge_detected=true"] } },
        { category: "gift_cards", category_status: "needs_manual_review", selected_link: { input_url: "https://example.com/gift" } },
      ],
      proposed_location_updates: [],
      proposed_touchpoint_events: [],
      manual_review_items: [
        { category: "ordering", reason: "challenge_or_timeout_requires_review" },
        { category: "gift_cards", reason: "category_requires_human_review" },
      ],
    },
  });
  const notifications = reviewNotifications(plan);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].category, "ordering");
  const message = reviewNotificationMessage(plan, notifications);
  assert.match(message, /My Pie Holladay/);
  assert.match(message, /No affected link was written/);
  assert.doesNotMatch(message, /gift_cards/);
});
