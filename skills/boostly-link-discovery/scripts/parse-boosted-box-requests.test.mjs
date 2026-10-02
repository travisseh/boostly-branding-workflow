#!/usr/bin/env node

import assert from "node:assert/strict";
import { parseSlackRequests } from "./parse-boosted-box-requests.mjs";

const baseAttachment = `*Account name:* Small Town Tavern
*Location Name:* Small Town Tavern
*Street Address:* 110 Sara Way
*City:* Belle Vernon
*State:* PA
*Postal Code:* 15012
*Owner:* Sterling Evans`;

const pairedPayload = {
  messages: [
    {
      text: "A Boostly Box Request has been submitted.",
      ts: "100.1",
      attachmentTexts: [baseAttachment],
    },
    {
      text: "Tab Cards Have Been Requested!",
      ts: "100.2",
      attachmentTexts: [
        `${baseAttachment}\n*Tap Card Offer:* Invite Offer\n*Front of House Employee Count:* 10`,
      ],
    },
  ],
};
const paired = parseSlackRequests(pairedPayload);

assert.equal(paired.length, 1);
assert.equal(paired[0].canonical_thread_ts, "100.1");
assert.equal(paired[0].badge_quantity, 10);
assert.equal(paired[0].badge_quantity_status, "valid");
assert.deepEqual(paired[0].request_types, ["boostly_box", "tap_cards"]);

const laterCounterpart = parseSlackRequests(pairedPayload, { afterTs: "100.15" });

assert.equal(laterCounterpart.length, 1);
assert.equal(laterCounterpart[0].canonical_thread_ts, "100.1");
assert.equal(laterCounterpart[0].badge_quantity, 10);

const noNewCounterpart = parseSlackRequests(pairedPayload, { afterTs: "100.2" });
assert.equal(noNewCounterpart.length, 0);

const conflict = parseSlackRequests({
  messages: [
    {
      text: "Tap Cards Have Been Requested!",
      ts: "200.1",
      attachmentTexts: [`${baseAttachment}\n*Front of House Employee Count:* 8`],
    },
    {
      text: "Tap Cards Have Been Requested!",
      ts: "200.2",
      attachmentTexts: [`${baseAttachment}\n*Front of House Employee Count:* 9`],
    },
  ],
});

assert.equal(conflict[0].badge_quantity, null);
assert.equal(conflict[0].badge_quantity_status, "conflict");

const inStore = parseSlackRequests({
  messages: [{
    text: "In-store request for Potbelly Sandwich Works (Fort Mill)",
    ts: "300.1",
    attachmentTexts: [],
    blockTexts: [
      "In-store request for Potbelly Sandwich Works (Fort Mill)",
      "*Account:* Potbelly Sandwich Works",
      "*Requested By:* Jonathan Watkins",
      "*Offer:* 20% OFF",
      "*Employees:* 10",
      "*Tables:* 10",
      "*Ship To:* Garrett McMullen, 1018 Gold Hill Road, Fort Mill, SC 29708",
    ],
  }],
});

assert.equal(inStore.length, 1);
assert.deepEqual(inStore[0].request_types, ["in_store"]);
assert.equal(inStore[0].fields.account_name, "Potbelly Sandwich Works");
assert.equal(inStore[0].fields.location_name, "Potbelly Sandwich Works (Fort Mill)");
assert.equal(inStore[0].fields.street_address, "1018 Gold Hill Road");
assert.equal(inStore[0].fields.city, "Fort Mill");
assert.equal(inStore[0].fields.state, "SC");
assert.equal(inStore[0].fields.postal_code, "29708");
assert.equal(inStore[0].fields.ship_to_name, "Garrett McMullen");
assert.equal(inStore[0].fields.owner, "Jonathan Watkins");
assert.equal(inStore[0].fields.table_count, "10");
assert.equal(inStore[0].badge_quantity, 10);
assert.equal(inStore[0].badge_quantity_status, "valid");

const adHoc = parseSlackRequests({
  messages: [{
    text: "In-store ad hoc request for Wingnutz Buffalo (Genesee)",
    ts: "400.1",
    attachmentTexts: [],
    blockTexts: [
      "In-store ad hoc request for Wingnutz Buffalo (Genesee)",
      "*Account:* Wingnutz",
      "*Requested By:* Tyler Price",
      "*Offer:* 10% Off",
      "*Items:* 20 x Tapcards",
      "*Ship To:* Wingnutz Buffalo (Genesee), 4600 Genesee Street, Suite 1, Buffalo, NY 14225",
    ],
  }],
});

assert.deepEqual(adHoc, []);

const escapedBusinessName = parseSlackRequests({
  messages: [{
    text: "In-store request for The Port Oysteria &amp; Brewery (Fredericksburg)",
    ts: "500.1",
    blockTexts: [
      "In-store request for The Port Oysteria &amp; Brewery (Fredericksburg)",
      "*Account:* The Port Oysteria &amp; Brewery",
      "*Employees:* 20",
      "*Tables:* 10",
      "*Ship To:* Tanya Ison, 8421 Heron Pointe Way, Spotsylvania, VA 22551",
    ],
  }],
});

assert.equal(escapedBusinessName[0].fields.account_name, "The Port Oysteria & Brewery");
assert.equal(
  escapedBusinessName[0].fields.location_name,
  "The Port Oysteria & Brewery (Fredericksburg)",
);
assert.match(escapedBusinessName[0].request_key, /the port oysteria brewery/);
assert.doesNotMatch(escapedBusinessName[0].request_key, /\bamp\b/);

console.log("parse-boosted-box-requests: ok");
