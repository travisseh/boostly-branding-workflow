#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const input = value("--input");
const output = value("--output");
if (!input || !output) throw new Error("usage: build-weekly-qa.mjs --input qa-data.json --output page.md");
const data = JSON.parse(fs.readFileSync(input, "utf8"));
const link = (label, url) => url ? `[${label}](${url})` : `${label}: unavailable`;
const screenshotCount = data.locations.filter((item) => item.screenshotPath).length;
const lines = [
  `# ${data.title}`,
  "",
  data.summary,
  "",
  `**Locations:** ${data.locations.length}`,
  "",
  "## Evidence",
  "",
  `Each location toggle contains fresh production readback. ${screenshotCount} of ${data.locations.length} toggles include an exact fulfillment Slack screenshot; locations without one are explicitly marked unavailable. No HTML previews or regenerated approximations are used.`,
  "",
];

for (const item of data.locations) {
  lines.push(
    `## ${item.locationName} {toggle="true"}`,
    `\t**Status:** ${item.disposition || "completed"} · **Account:** ${item.accountName || "unresolved"} · **Location ID:** \`${item.locationId || "unresolved"}\` · **Request key:** \`${item.requestKey || "unresolved"}\` · **Canonical Slack ts:** \`${item.canonicalThreadTs || "unresolved"}\` · **Submitted:** ${item.submittedAt}`,
    `\t**Address:** ${item.address || "unresolved"}`,
    `\t**Admin:** ${item.accountId ? `[Open Boostly account](https://new.boostly.com/admin/accounts/${item.accountId})` : "unavailable"} · **Slack:** [Open request thread](${item.slackThreadUrl})${item.publicUrl ? ` · **Live link tree:** [${item.publicUrl}](${item.publicUrl})` : ""}`,
    "",
    "\t### Core location links",
    `\t- [ ] ${link("Website", item.websiteUrl)}`,
    `\t- [ ] ${link("Ordering", item.orderingUrl)}`,
    "",
    "\t### Social and app links",
  );
  if (item.socials?.length) for (const social of item.socials) lines.push(`\t- [ ] ${link(social.label, social.url)} · scope: ${item.brandingScope || "unknown"}`);
  else lines.push("\t- [ ] No social URLs saved.");
  if (item.apps?.length) for (const app of item.apps) lines.push(`\t- [ ] ${link(app.label, app.url)} · scope: ${item.brandingScope || "unknown"}`);
  else lines.push("\t- [ ] No app download URLs saved.");
  lines.push("", "\t### Standard link-tree sections");
  if (item.standardEvents?.length) for (const event of item.standardEvents) lines.push(`\t- [ ] **${event.active ? "LIVE" : "INACTIVE"}** · type: **${event.type || "blank"}** · title: **${event.title || "blank"}** · display title: **${event.displayTitle || "blank"}** · description: **${event.description || "blank"}** · button: **${event.buttonText || "blank"}** · ${event.link ? `[open destination](${event.link})` : "no URL"}`);
  else lines.push("\t- [ ] No standard event readback available.");
  lines.push("", "\t### Custom Link/Product events");
  if (item.customEvents?.length) for (const event of item.customEvents) lines.push(`\t- [ ] **${event.active ? "LIVE" : "INACTIVE"}** · title: **${event.title || "blank"}** · display title: **${event.displayTitle || "blank"}** · description: **${event.description || "blank"}** · button: **${event.buttonText || "blank"}** · ${event.link ? `[open destination](${event.link})` : "no URL"}`);
  else lines.push("\t- [ ] No custom Link/Product events saved.");
  lines.push("", "\t### Holds and exceptions");
  if (item.holds?.length) for (const hold of item.holds) lines.push(`\t- [ ] **${hold.category}:** ${hold.url ? `[candidate](${hold.url}) · ` : ""}${hold.reason || "held for review"}`);
  else lines.push("\t- [ ] No recorded holds.");
  lines.push("", "\t### GPT-5.6 Luna visual verification");
  lines.push(`\t- [ ] ${item.visualVerification || "Visual review unavailable; do not treat the screenshot as current-state proof."}`);
  const b = item.branding || {};
  lines.push(
    "",
    "\t### Branding and badges",
    `\t- [ ] Scope: **${item.brandingScope || "unknown"}**`,
    `\t- [ ] Web colors: primary **${b.web_primary_color || "not saved"}** · secondary **${b.web_secondary_color || "not saved"}** · text **${b.web_text_color || "not saved"}**`,
    `\t- [ ] Print colors: primary **${b.print_primary_color || "not saved"}** · secondary **${b.print_secondary_color || "not saved"}** · text **${b.print_text_color || "not saved"}**`,
    `\t- [ ] Logo: ${b.logo_url ? `[open production logo](${b.logo_url})` : "**none saved**"}`,
    `\t- [ ] Active badges: **${item.badgeCount ?? "unavailable"}** · unassigned: **${item.unassignedBadgeCount ?? "unavailable"}**`,
    `\t- [ ] Fulfillment screenshot: ${item.screenshotPath ? "attached below" : "unavailable"}`,
    "",
  );
}
fs.writeFileSync(output, lines.join("\n"));
console.log(JSON.stringify({ output, locations: data.locations.length }));
