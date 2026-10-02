export const CUSTOM_LINK_PRESENTATION = {
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
} as const;

export const CAREERS_DISPLAY_TITLE = CUSTOM_LINK_PRESENTATION.careers_jobs.display_title;
export const CAREERS_BUTTON_TEXT = CUSTOM_LINK_PRESENTATION.careers_jobs.button_text;
export const CUSTOM_LINK_DESCRIPTION_FALLBACK = "Learn more";
export const CUSTOM_LINK_DESCRIPTION_MAX_LENGTH = 40;
export const LINK_TREE_MAX_ACTIVE_SECTIONS = 6;

type CustomLinkCategory = keyof typeof CUSTOM_LINK_PRESENTATION;

type LinkTreeEvent = {
  type: string;
  title: string;
  display_title: string | null;
  description?: string | null;
  primary_button_text: string | null;
  link?: string | null;
  sort_order?: number;
  is_active: boolean;
};

export type LinkTreeActivationEvidence = {
  hasVerifiedSocials: boolean;
  hasVerifiedUpcomingEvents?: boolean;
  hasVerifiedOpenings?: boolean;
};

export function applyCustomLinkPresentation<T extends LinkTreeEvent>(
  event: T,
  category?: string,
): T {
  const resolvedCategory = resolveCustomLinkCategory(category, event);
  const describedEvent = applyCustomLinkDescription(event, category);
  if (!resolvedCategory) return describedEvent;
  const template = CUSTOM_LINK_PRESENTATION[resolvedCategory];
  return {
    ...describedEvent,
    title: template.title,
    display_title: template.display_title,
    description: template.description,
    primary_button_text: template.button_text,
  };
}

export function applyCustomLinkDescription<T extends LinkTreeEvent>(
  event: T,
  category?: string,
): T {
  const resolvedCategory = resolveCustomLinkCategory(category, event);
  const description = resolvedCategory
    ? CUSTOM_LINK_PRESENTATION[resolvedCategory].description
    : event.description?.trim() || CUSTOM_LINK_DESCRIPTION_FALLBACK;
  return { ...event, description };
}

export function applyCareersPresentation<T extends LinkTreeEvent>(
  event: T,
  category?: string,
): T {
  return resolveCustomLinkCategory(category, event) === "careers_jobs"
    ? applyCustomLinkPresentation(event, category)
    : event;
}

export function normalizeLegacyInactiveCustomPlaceholders<
  T extends LinkTreeEvent,
>(events: T[]): T[] {
  return events.map((event) => {
    if (
      event.type !== "custom" ||
      event.is_active ||
      event.link?.trim() ||
      !event.primary_button_text?.trim()
    ) {
      return { ...event };
    }
    return { ...event, primary_button_text: null };
  });
}

export function isDisallowedCustomLink(
  category: string | undefined,
  event: Pick<LinkTreeEvent, "title" | "display_title">,
): boolean {
  const normalizedCategory = normalize(category ?? "");
  if (["special", "specials", "dailyspecials", "weeklyspecials", "monthlyspecials", "dinnerspecials", "lunchspecials"].includes(normalizedCategory)) {
    return true;
  }

  return [event.title, event.display_title]
    .filter(Boolean)
    .some((value) => {
      const identity = String(value).trim().toLowerCase();
      const withoutSpecialEvents = identity.replace(/\bspecial events?\b/g, "");
      return /\b(?:(?:daily|weekly|monthly|dinner|lunch)\s+)?specials?\b/.test(
        withoutSpecialEvents,
      );
    });
}

export function enforceLinkTreeVisibility<T extends LinkTreeEvent>(
  events: T[],
  evidence: boolean | LinkTreeActivationEvidence,
): {
  events: T[];
  changed: string[];
  missing: string[];
} {
  let next = events.map((event) => ({ ...event }));
  const changed: string[] = [];
  const missing: string[] = [];
  const activationEvidence = normalizeActivationEvidence(evidence);

  next = next.map((event) => {
    if (event.type !== "custom") return event;
    const presented = applyCustomLinkPresentation(event);
    if (
      presented.title !== event.title ||
      presented.display_title !== event.display_title ||
      presented.description !== event.description ||
      presented.primary_button_text !== event.primary_button_text
    ) {
      changed.push(`presentation:${event.title}`);
    }
    return presented;
  });

  const hasActiveOrdering = next.some((event) =>
    event.type === "custom" &&
    event.is_active &&
    resolveCustomLinkCategory(undefined, event) === "ordering"
  );
  let disabledRedundantMenu = false;
  if (hasActiveOrdering) {
    for (const event of next) {
      if (
        event.type === "custom" &&
        event.is_active &&
        resolveCustomLinkCategory(undefined, event) === "menu"
      ) {
        event.is_active = false;
        disabledRedundantMenu = true;
      }
    }
  }
  if (disabledRedundantMenu) {
    changed.push("menu_duplicate_of_order");
  }

  const review = next.find((event) => event.type === "review");
  if (!review) missing.push("review");
  else if (!review.is_active) {
    review.is_active = true;
    changed.push("review");
  }

  const eventLinks = next.filter((event) =>
    event.type === "custom" &&
    resolveCustomLinkCategory(undefined, event) === "events"
  );
  if (activationEvidence.hasVerifiedUpcomingEvents === true && eventLinks.length === 0) {
    missing.push("events");
  }
  if (activationEvidence.hasVerifiedUpcomingEvents !== undefined) {
    setEventsActive(
      eventLinks,
      activationEvidence.hasVerifiedUpcomingEvents,
      changed,
      "events",
    );
  }

  const careersLinks = next.filter((event) =>
    event.type === "custom" &&
    resolveCustomLinkCategory(undefined, event) === "careers_jobs"
  );
  if (activationEvidence.hasVerifiedOpenings === true && careersLinks.length === 0) {
    missing.push("careers");
  }
  if (activationEvidence.hasVerifiedOpenings !== undefined) {
    setEventsActive(
      careersLinks,
      activationEvidence.hasVerifiedOpenings,
      changed,
      "careers",
    );
  }

  const socials = next.filter((event) => event.type === "socials");
  if (activationEvidence.hasVerifiedSocials && socials.length === 0) {
    missing.push("socials");
  }
  setEventsActive(
    socials,
    activationEvidence.hasVerifiedSocials,
    changed,
    "socials",
  );

  const activeByPriority = next
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.is_active)
    .sort((left, right) =>
      linkTreeSectionPriority(left.event) - linkTreeSectionPriority(right.event) ||
      (left.event.sort_order ?? left.index) - (right.event.sort_order ?? right.index) ||
      left.index - right.index
    );
  for (const { event } of activeByPriority.slice(LINK_TREE_MAX_ACTIVE_SECTIONS)) {
    event.is_active = false;
    changed.push(`section_limit:${event.title}`);
  }

  return { events: next, changed, missing };
}

function normalizeActivationEvidence(
  evidence: boolean | LinkTreeActivationEvidence,
): {
  hasVerifiedSocials: boolean;
  hasVerifiedUpcomingEvents?: boolean;
  hasVerifiedOpenings?: boolean;
} {
  if (typeof evidence === "boolean") {
    return { hasVerifiedSocials: evidence };
  }
  return evidence;
}

function setEventsActive<T extends LinkTreeEvent>(
  events: T[],
  isActive: boolean,
  changed: string[],
  changeName: string,
): void {
  let didChange = false;
  for (const event of events) {
    if (event.is_active !== isActive) {
      event.is_active = isActive;
      didChange = true;
    }
  }
  if (didChange) changed.push(changeName);
}

function linkTreeSectionPriority(event: LinkTreeEvent): number {
  if (event.type === "review") return 0;
  if (event.type === "socials") return 1;
  if (event.type === "subscribe") return 2;
  if (event.type === "downloads") return 7;
  if (event.type !== "custom") return 8;

  const category = resolveCustomLinkCategory(undefined, event);
  if (category === "ordering" || category === "menu") return 3;
  if (category === "events" || category === "reservations") return 4;
  if (category === "catering") return 5;
  if (category === "careers_jobs") return 6;
  return 8;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function resolveCustomLinkCategory(
  category: string | undefined,
  event: Pick<LinkTreeEvent, "title" | "display_title">,
): CustomLinkCategory | null {
  const categoryAlias = normalize(category ?? "");
  const categoryMap: Record<string, CustomLinkCategory> = {
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
  if (categoryMap[categoryAlias]) return categoryMap[categoryAlias];

  const identityParts = [event.title, event.display_title]
    .filter(Boolean)
    .map((value) => normalize(String(value)));
  const identity = identityParts.join("");
  if (/career|jobs|employment|joinourteam/.test(identity)) return "careers_jobs";
  if (identityParts.some((value) => /^(?:order|ordering|orderonline|onlineordering)$/.test(value))) return "ordering";
  if (/catering/.test(identity)) return "catering";
  if (/menu/.test(identity)) return "menu";
  if (/events?/.test(identity)) return "events";
  if (/reservations?|reserve/.test(identity)) return "reservations";
  return null;
}
