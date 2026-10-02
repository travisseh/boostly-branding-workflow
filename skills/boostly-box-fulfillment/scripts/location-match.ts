export type FulfillmentRequestIdentity = {
  account_name: string;
  location_name: string;
  street_address: string;
  city: string;
  state: string;
  postal_code: string;
};

export type LocationCandidate = {
  location_id: string;
  location_name: string;
  location_status: string;
  account_id: string;
  account_name: string;
  account_status?: string;
  address: string;
  website_url?: string | null;
  google_place_id?: string | null;
  is_general?: boolean;
};

export type LocationMatch =
  | {
      status: "matched";
      location: LocationCandidate;
      match_basis: "exact_address" | "single_location_shipping_address";
      normalized: { account_name: string; location_name: string; address: string };
    }
  | {
      status: "needs_model_review";
      reason: "no_exact_match" | "ambiguous_exact_match";
      candidates: LocationCandidate[];
      normalized: { account_name: string; location_name: string; address: string };
    };

const ADDRESS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(street|str)\b/g, "st"],
  [/\b(avenue)\b/g, "ave"],
  [/\b(road)\b/g, "rd"],
  [/\b(boulevard)\b/g, "blvd"],
  [/\b(drive)\b/g, "dr"],
  [/\b(lane)\b/g, "ln"],
  [/\b(court)\b/g, "ct"],
  [/\b(highway)\b/g, "hwy"],
  [/\b(parkway)\b/g, "pkwy"],
  [/\b(suite)\b/g, "ste"],
  [/\b(north)\b/g, "n"],
  [/\b(south)\b/g, "s"],
  [/\b(east)\b/g, "e"],
  [/\b(west)\b/g, "w"],
  [/\b(united states of america|united states|usa)\b/g, ""],
];

export function normalizeBusinessName(value: string): string {
  return normalizeWords(value)
    .replace(/\b(the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeFullAddress(value: string): string {
  let normalized = normalizeWords(value);
  for (const [pattern, replacement] of ADDRESS_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/\s+/g, " ").trim();
}

export function requestFullAddress(request: FulfillmentRequestIdentity): string {
  return [
    request.street_address,
    request.city,
    request.state,
    request.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
}

export function matchLocationExactly(
  request: FulfillmentRequestIdentity,
  candidates: LocationCandidate[],
): LocationMatch {
  const normalized = {
    account_name: normalizeBusinessName(request.account_name),
    location_name: normalizeBusinessName(request.location_name),
    address: normalizeFullAddress(requestFullAddress(request)),
  };
  const customerCandidates = candidates.filter((candidate) => candidate.is_general !== true);
  // V2 disambiguates multi-location brands as "Name (City)". A request that
  // omits that suffix is still the same business when the suffix is exactly
  // the request's own city AND the full address matches (El Guapo lesson,
  // 2026-08-11: "El Guapo" vs "El Guapo (Catonsville)" blocked branding and
  // 25 badges despite a byte-exact address). Only the city parenthetical is
  // stripped; every other name difference still requires review.
  const requestCity = normalizeBusinessName(request.city);
  const comparableName = (rawName: string): string => {
    const raw = String(rawName ?? "").trim();
    const suffix = /\s*\(([^)]+)\)\s*$/.exec(raw);
    if (suffix && requestCity && normalizeBusinessName(suffix[1]) === requestCity) {
      return normalizeBusinessName(raw.slice(0, suffix.index));
    }
    return normalizeBusinessName(raw);
  };
  const requestComparable = comparableName(request.location_name);
  const exact = customerCandidates.filter((candidate) =>
    normalizeBusinessName(candidate.account_name) === normalized.account_name &&
    comparableName(candidate.location_name) === requestComparable &&
    normalizeFullAddress(candidate.address) === normalized.address,
  );
  if (exact.length === 1) return { status: "matched", location: exact[0], match_basis: "exact_address", normalized };
  // Box/Tap-Card request forms sometimes carry a SHIPPING address (often the
  // owner's home) in the location-address fields instead of the restaurant's
  // address (Um.ma lesson, 2026-08-11: "328 Anita Dr, Millbrae" was a ship-to;
  // the only real location is 1220 9th Ave, San Francisco — the exact-address
  // policy held branding, links, and 20 badges for an unambiguous customer).
  // When BOTH names match exactly a single candidate whose account has exactly
  // one customer location among the candidates, the business identity is
  // unambiguous and the address is treated as a ship-to, flagged via
  // match_basis so downstream surfaces the discrepancy in review artifacts.
  // Any name ambiguity (two name matches, or a multi-location account) still
  // requires model review.
  // For the fallback the request city is a ship-to city, so the city-suffix
  // strip above cannot fire; strip ANY trailing V2 "(City)" disambiguator on
  // both sides instead. Account-name equality plus the single-location
  // constraint still anchors identity.
  if (exact.length === 0) {
    const baseName = (rawName: string): string =>
      normalizeBusinessName(String(rawName ?? "").trim().replace(/\s*\([^)]+\)\s*$/, ""));
    const requestBase = baseName(request.location_name);
    const nameMatches = customerCandidates.filter((candidate) =>
      normalizeBusinessName(candidate.account_name) === normalized.account_name &&
      baseName(candidate.location_name) === requestBase,
    );
    if (nameMatches.length === 1) {
      const only = nameMatches[0];
      const accountSiblings = customerCandidates.filter(
        (candidate) => candidate.account_id === only.account_id,
      );
      if (accountSiblings.length === 1) {
        return { status: "matched", location: only, match_basis: "single_location_shipping_address", normalized };
      }
    }
  }
  return {
    status: "needs_model_review",
    reason: exact.length > 1 ? "ambiguous_exact_match" : "no_exact_match",
    candidates: exact.length ? exact : customerCandidates,
    normalized,
  };
}

export function selectBrandingScope(
  target: LocationCandidate,
  accountLocations: LocationCandidate[],
): "account" | "location" {
  if (target.is_general) throw new Error("General locations cannot be fulfillment targets");
  const eligible = accountLocations.filter((location) =>
    location.account_id === target.account_id &&
    location.is_general !== true &&
    ["enabled", "paused"].includes(location.location_status),
  );
  if (!eligible.some((location) => location.location_id === target.location_id)) {
    throw new Error("Target is not an enabled/paused non-General account location");
  }
  return eligible.length === 1 ? "account" : "location";
}

function normalizeWords(value: string): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
