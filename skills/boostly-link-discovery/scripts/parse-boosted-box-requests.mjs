#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const FIELD_NAMES = new Map([
  ["account name", "account_name"],
  ["location name", "location_name"],
  ["street address", "street_address"],
  ["city", "city"],
  ["state", "state"],
  ["postal code", "postal_code"],
  ["owner", "owner"],
  ["tap card offer", "tap_card_offer"],
  ["boostly box offer", "boostly_box_offer"],
  ["front of house employee list", "front_of_house_employee_list"],
  ["front of house employee count", "front_of_house_employee_count"],
  ["account", "account_name"],
  ["requested by", "requested_by"],
  ["offer", "offer"],
  ["employees", "front_of_house_employee_count"],
  ["tables", "table_count"],
  ["ship to", "ship_to"],
]);

export function parseSlackRequests(payload, { afterTs } = {}) {
  const messages = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];
  const parsed = messages.map(parseRequestMessage).filter(Boolean);
  const groups = new Map();
  for (const request of parsed) {
    const current = groups.get(request.request_key) || [];
    current.push(request);
    groups.set(request.request_key, current);
  }
  return [...groups.values()]
    .filter(
      (group) =>
        !afterTs ||
        group.some((request) => Number(request.message_ts) > Number(afterTs)),
    )
    .map(pairRequestMessages)
    .sort((left, right) => Number(left.canonical_thread_ts) - Number(right.canonical_thread_ts));
}

export function parseRequestMessage(message) {
  const attachmentTexts = Array.isArray(message?.attachmentTexts)
    ? message.attachmentTexts
    : [];
  const blockTexts = Array.isArray(message?.blockTexts) ? message.blockTexts : [];
  const content = decodeSlackText(
    [message?.text || "", ...attachmentTexts, ...blockTexts].join("\n"),
  );
  const isAdHocInStore = /(?:^|\n)\s*in-store\s+ad(?:\s+|-)hoc\s+request\s+for\b/im.test(
    content,
  );
  if (isAdHocInStore) return null;

  const isTapCards = /ta[bp]\s+cards?\s+have\s+been\s+requested/i.test(content);
  const isBox = /boost(?:ly|ed)\s+box.*(?:requested|request\s+has\s+been\s+submitted)/i.test(
    content,
  );
  const isInStore = /in-store\s+request\s+for\s+.+/i.test(content);
  if (!isTapCards && !isBox && !isInStore) return null;

  const fields = {};
  for (const line of content.split(/\r?\n/)) {
    const clean = line.replace(/\*/g, "").trim();
    const match = clean.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = FIELD_NAMES.get(normalizeWords(match[1]));
    if (key) fields[key] = match[2].trim();
  }
  if (isInStore) normalizeInStoreFields(fields, content);
  const requestKey = buildRequestKey(fields);
  if (!requestKey) return null;
  return {
    request_type: isInStore ? "in_store" : isTapCards ? "tap_cards" : "boostly_box",
    message_ts: String(message.ts || ""),
    request_key: requestKey,
    fields,
  };
}

function pairRequestMessages(messages) {
  const ordered = messages
    .slice()
    .sort((left, right) => Number(left.message_ts) - Number(right.message_ts));
  const mergedFields = Object.assign({}, ...ordered.map((message) => message.fields));
  const tapMessages = ordered.filter((message) =>
    ["tap_cards", "in_store"].includes(message.request_type),
  );
  const rawCounts = tapMessages.map(
    (message) => message.fields.front_of_house_employee_count || "",
  );
  const parsedCounts = rawCounts.map((value) => {
    const normalized = String(value).trim();
    return /^\d+$/.test(normalized) ? Number(normalized) : null;
  });
  const distinctCounts = [...new Set(parsedCounts.filter((value) => value !== null))];

  let badgeQuantity = null;
  let badgeQuantityStatus = "missing";
  if (rawCounts.some((value) => value && !/^\d+$/.test(String(value).trim()))) {
    badgeQuantityStatus = "invalid";
  } else if (distinctCounts.length > 1) {
    badgeQuantityStatus = "conflict";
  } else if (distinctCounts.length === 1) {
    badgeQuantity = distinctCounts[0];
    badgeQuantityStatus =
      badgeQuantity >= 2 && badgeQuantity <= 100 ? "valid" : "invalid";
  }

  return {
    request_key: ordered[0].request_key,
    canonical_thread_ts: ordered[0].message_ts,
    paired_message_ts: ordered.map((message) => message.message_ts),
    request_types: [...new Set(ordered.map((message) => message.request_type))],
    fields: mergedFields,
    badge_quantity: badgeQuantity,
    badge_quantity_status: badgeQuantityStatus,
    badge_quantity_source: tapMessages.map((message) => message.message_ts),
  };
}

function normalizeInStoreFields(fields, content) {
  const title = content.match(/in-store\s+request\s+for\s+([^\n]+)/i)?.[1]?.trim();
  if (title) fields.location_name = title;
  if (fields.requested_by) fields.owner = fields.requested_by;
  if (fields.offer) {
    fields.tap_card_offer = fields.offer;
    fields.boostly_box_offer = fields.offer;
  }
  if (fields.ship_to) Object.assign(fields, parseShipTo(fields.ship_to));
}

function parseShipTo(value) {
  const parts = String(value).split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 4) return {};
  const stateZip = parts.at(-1).match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!stateZip) return {};
  return {
    ship_to_name: parts[0],
    street_address: parts.slice(1, -2).join(", "),
    city: parts.at(-2),
    state: stateZip[1],
    postal_code: stateZip[2],
  };
}

function buildRequestKey(fields) {
  const parts = [
    fields.account_name,
    fields.location_name,
    fields.street_address,
    fields.city,
    fields.state,
    fields.postal_code,
  ].map(normalizeWords);
  return parts.every(Boolean) ? parts.join("|") : null;
}

function normalizeWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function decodeSlackText(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      options[key] = value;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = options.file
    ? fs.readFileSync(options.file, "utf8")
    : fs.readFileSync(0, "utf8");
  const payload = JSON.parse(input);
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const requests = parseSlackRequests(payload, { afterTs: options["after-ts"] });
  const messageCount = Array.isArray(payload) ? payload.length : Array.isArray(payload?.messages) ? payload.messages.length : 0;
  process.stdout.write(`${JSON.stringify({
    requests,
    stage_metrics: [{
      stage: "slack_parse",
      started_at: startedAt,
      duration_ms: Number((performance.now() - startedMs).toFixed(3)),
      counters: { messages_total: messageCount, canonical_requests: requests.length },
      outcome: "ok",
    }],
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
