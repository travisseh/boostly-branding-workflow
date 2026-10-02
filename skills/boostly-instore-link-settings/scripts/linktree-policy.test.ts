#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  CAREERS_BUTTON_TEXT,
  CAREERS_DISPLAY_TITLE,
  CUSTOM_LINK_DESCRIPTION_FALLBACK,
  CUSTOM_LINK_PRESENTATION,
  LINK_TREE_MAX_ACTIVE_SECTIONS,
  applyCustomLinkDescription,
  applyCustomLinkPresentation,
  applyCareersPresentation,
  enforceLinkTreeVisibility,
  isDisallowedCustomLink,
  normalizeLegacyInactiveCustomPlaceholders,
} from "./linktree-policy.ts";

const careers = applyCareersPresentation({
  type: "custom",
  title: "Careers",
  display_title: "Careers",
  description: "",
  primary_button_text: "Learn More",
  is_active: true,
}, "careers_jobs");
assert.equal(careers.display_title, CAREERS_DISPLAY_TITLE);
assert.equal(careers.primary_button_text, CAREERS_BUTTON_TEXT);
assert.equal(careers.description, "Grow with our team");

const generic = applyCustomLinkDescription({
  type: "custom",
  title: "Private Dining",
  display_title: "Private Dining",
  description: "",
  primary_button_text: "Learn More",
  is_active: true,
});
assert.equal(generic.description, CUSTOM_LINK_DESCRIPTION_FALLBACK);

const legacyOrder = applyCustomLinkDescription({
  type: "custom",
  title: "Order",
  display_title: "Order",
  description: null,
  primary_button_text: "Order Now",
  is_active: true,
});
assert.equal(legacyOrder.description, "Order your favorites");

assert.deepEqual(CUSTOM_LINK_PRESENTATION, {
  ordering: {
    title: "Order Online",
    display_title: "Order Online",
    description: "Order your favorites",
    button_text: "Order Now",
  },
  careers_jobs: {
    title: "Careers",
    display_title: "Join Our Team",
    description: "Grow with our team",
    button_text: "Apply Now",
  },
  menu: {
    title: "Menu",
    display_title: "Menu",
    description: "See what's cooking",
    button_text: "View Menu",
  },
  catering: {
    title: "Catering",
    display_title: "Catering",
    description: "Food for your gathering",
    button_text: "View Options",
  },
  events: {
    title: "Events",
    display_title: "Events",
    description: "See what's happening",
    button_text: "View Events",
  },
  reservations: {
    title: "Reservations",
    display_title: "Reservations",
    description: "Save your table",
    button_text: "Reserve Now",
  },
});

for (const [category, template] of Object.entries(CUSTOM_LINK_PRESENTATION)) {
  const event = applyCustomLinkPresentation({
    type: "custom",
    title: "WRONG TITLE",
    display_title: "WRONG TITLE",
    description: "Too long and inconsistent",
    primary_button_text: "Click Here",
    is_active: true,
  }, category);
  assert.equal(event.title, template.title);
  assert.equal(event.display_title, template.display_title);
  assert.equal(event.description, template.description);
  assert.equal(event.primary_button_text, template.button_text);
  assert(event.display_title.trim().length > 0);
  assert(event.description.trim().length > 0);
  assert(event.primary_button_text.trim().length > 0);
}

assert.equal(isDisallowedCustomLink("specials", { title: "Specials", display_title: "Specials" }), true);
assert.equal(isDisallowedCustomLink(undefined, { title: "DINNER SPECIALS", display_title: "Monthly Specials" }), true);
assert.equal(isDisallowedCustomLink("events", { title: "Specials", display_title: "Specials" }), true);
assert.equal(isDisallowedCustomLink("events", { title: "Specials", display_title: "Special Events" }), true);
assert.equal(isDisallowedCustomLink("events", { title: "Events", display_title: "Special Events" }), false);

const baseline = [
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, is_active: false },
  { type: "socials", title: "Socials", display_title: "Socials", primary_button_text: null, is_active: false },
];
const enabled = enforceLinkTreeVisibility(baseline, true);
assert.deepEqual(enabled.changed, ["review", "socials"]);
assert.deepEqual(enabled.missing, []);
assert(enabled.events.every((event) => event.is_active));
assert.equal(baseline[0].is_active, false, "policy must not mutate the input baseline");

const noSocials = enforceLinkTreeVisibility(baseline, false);
assert.equal(noSocials.events.find((event) => event.type === "review")?.is_active, true);
assert.equal(noSocials.events.find((event) => event.type === "socials")?.is_active, false);

const missing = enforceLinkTreeVisibility([], true);
assert.deepEqual(missing.missing, ["review", "socials"]);

const legacyPlaceholders = [
  { type: "custom", title: "Menu", display_title: "Menu", primary_button_text: "View Menu", link: null, is_active: false },
  { type: "custom", title: "Order Online", display_title: "Order Online", primary_button_text: "Order Now", link: "https://example.com/order", is_active: true },
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, link: null, is_active: true },
];
const normalizedPlaceholders =
  normalizeLegacyInactiveCustomPlaceholders(legacyPlaceholders);
assert.equal(normalizedPlaceholders[0].primary_button_text, null);
assert.equal(normalizedPlaceholders[1].primary_button_text, "Order Now");
assert.equal(normalizedPlaceholders[2].primary_button_text, null);
assert.equal(
  legacyPlaceholders[0].primary_button_text,
  "View Menu",
  "policy must not mutate the input baseline",
);

const duplicateMenu = enforceLinkTreeVisibility([
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, is_active: true },
  { type: "socials", title: "Socials", display_title: "Socials", primary_button_text: null, is_active: true },
  { type: "custom", title: "Order Online", display_title: "Order Online", description: "Pickup or delivery", primary_button_text: "Order Now", link: "https://order.example.com/store/?utm_source=site", is_active: true },
  { type: "custom", title: "Menu", display_title: "Menu", description: "See what's cooking", primary_button_text: "View Menu", link: "https://www.order.example.com/store#menu", is_active: true },
  { type: "custom", title: "Menu", display_title: "Menu", description: "See what's cooking", primary_button_text: "View Menu", link: "https://example.com/menu", is_active: true },
], true);
assert.deepEqual(duplicateMenu.changed, [
  "presentation:Order Online",
  "menu_duplicate_of_order",
]);
assert.equal(duplicateMenu.events.filter((event) => event.title === "Order Online").length, 1);
assert.deepEqual(
  duplicateMenu.events.filter((event) => event.title === "Menu").map((event) => event.is_active),
  [false, false],
);

const repairedDescription = enforceLinkTreeVisibility([
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, is_active: true },
  { type: "custom", title: "Private Dining", display_title: "Private Dining", description: null, primary_button_text: "Learn More", link: "https://example.com/private-dining", is_active: true },
], false);
assert.deepEqual(repairedDescription.changed, ["presentation:Private Dining"]);
assert.equal(repairedDescription.events[1].description, CUSTOM_LINK_DESCRIPTION_FALLBACK);

const repairedCatering = enforceLinkTreeVisibility([
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, is_active: true },
  { type: "custom", title: "CATERING", display_title: "CATERING", description: "Learn more", primary_button_text: "Learn More", link: "https://example.com/catering", is_active: true },
], false);
assert.deepEqual(repairedCatering.changed, ["presentation:CATERING"]);
assert.deepEqual(repairedCatering.events[1], {
  type: "custom",
  title: "Catering",
  display_title: "Catering",
  description: "Food for your gathering",
  primary_button_text: "View Options",
  link: "https://example.com/catering",
  is_active: true,
});

const activationBaseline = [
  { type: "subscribe", title: "Subscribe", display_title: "Subscribe", primary_button_text: null, is_active: true, sort_order: 7 },
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, is_active: false, sort_order: 6 },
  { type: "custom", title: "Order Online", display_title: "Order Online", primary_button_text: "Order Now", link: "https://example.com/order", is_active: true, sort_order: 5 },
  { type: "custom", title: "Menu", display_title: "Menu", primary_button_text: "View Menu", link: "https://example.com/menu", is_active: true, sort_order: 4 },
  { type: "custom", title: "Events", display_title: "Events", primary_button_text: "View Events", link: "https://example.com/events", is_active: false, sort_order: 3 },
  { type: "downloads", title: "Apps", display_title: "Apps", primary_button_text: null, is_active: true, sort_order: 2 },
  { type: "custom", title: "Catering", display_title: "Catering", primary_button_text: "View Options", link: "https://example.com/catering", is_active: true, sort_order: 1 },
  { type: "custom", title: "Careers", display_title: "Join Our Team", primary_button_text: "Apply Now", link: "https://example.com/careers", is_active: true, sort_order: 0 },
  { type: "socials", title: "Socials", display_title: "Socials", primary_button_text: null, is_active: false, sort_order: 8 },
];
const activated = enforceLinkTreeVisibility(activationBaseline, {
  hasVerifiedSocials: true,
  hasVerifiedUpcomingEvents: true,
  hasVerifiedOpenings: true,
});
assert.equal(
  activated.events.filter((event) => event.is_active).length,
  LINK_TREE_MAX_ACTIVE_SECTIONS,
);
assert.deepEqual(
  activated.events.filter((event) => event.is_active).map((event) => event.title),
  ["Subscribe", "Reviews", "Order Online", "Events", "Catering", "Socials"],
);
assert.equal(activated.events.find((event) => event.title === "Menu")?.is_active, false);
assert.equal(activated.events.find((event) => event.title === "Careers")?.is_active, false);
assert.equal(activated.events.find((event) => event.type === "socials")?.is_active, true);
assert.equal(activated.events.find((event) => event.type === "downloads")?.is_active, false);
assert.equal(activationBaseline[1].is_active, false, "activation policy must not mutate its input");

const evidenceGates = enforceLinkTreeVisibility([
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, is_active: false },
  { type: "custom", title: "Events", display_title: "Events", primary_button_text: "View Events", link: "https://example.com/events", is_active: true },
  { type: "custom", title: "Careers", display_title: "Join Our Team", primary_button_text: "Apply Now", link: "https://example.com/careers", is_active: true },
  { type: "socials", title: "Socials", display_title: "Socials", primary_button_text: null, is_active: true },
], {
  hasVerifiedSocials: false,
  hasVerifiedUpcomingEvents: false,
  hasVerifiedOpenings: false,
});
assert.equal(evidenceGates.events.find((event) => event.type === "review")?.is_active, true);
assert.equal(evidenceGates.events.find((event) => event.title === "Events")?.is_active, false);
assert.equal(evidenceGates.events.find((event) => event.title === "Careers")?.is_active, false);
assert.equal(evidenceGates.events.find((event) => event.type === "socials")?.is_active, false);

const unknownCareersState = enforceLinkTreeVisibility([
  { type: "review", title: "Reviews", display_title: "Reviews", primary_button_text: null, is_active: true },
  { type: "custom", title: "Careers", display_title: "Join Our Team", primary_button_text: "Apply Now", link: "https://example.com/careers", is_active: true },
], {
  hasVerifiedSocials: false,
  hasVerifiedUpcomingEvents: false,
});
assert.equal(unknownCareersState.events.find((event) => event.title === "Careers")?.is_active, true);

console.log("linktree-policy: ok");
