#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  google-profile-public-snapshot.sh --place-id <google_place_id>
  google-profile-public-snapshot.sh --query "<business name and address>"

Loads GOOGLE_PLACES_API_KEY from the environment or ~/.config/boostly-branding/.env.
USAGE
}

PLACE_ID=""
QUERY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --place-id)
      PLACE_ID="${2:-}"
      shift 2
      ;;
    --query)
      QUERY="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$PLACE_ID" && -z "$QUERY" ]]; then
  usage
  exit 2
fi

node - "$PLACE_ID" "$QUERY" <<'NODE'
const fs = require('node:fs');

const [placeIdArg, queryArg] = process.argv.slice(2);

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return;
  const text = fs.readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile(`${process.env.HOME}/.config/boostly-branding/.env`);

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  throw new Error('Missing GOOGLE_PLACES_API_KEY');
}

const fieldMask = [
  'id',
  'displayName',
  'formattedAddress',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'googleMapsUri',
  'googleMapsLinks',
  'businessStatus',
  'types',
  'primaryType',
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'timeZone',
].join(',');

async function googleFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function searchPlace(query) {
  const body = await googleFetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.googleMapsUri',
    },
    body: JSON.stringify({ textQuery: query, pageSize: 5 }),
  });
  return body.places || [];
}

async function getDetails(placeId) {
  return googleFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-FieldMask': fieldMask },
  });
}

async function fetchWebsiteLinks(websiteUri) {
  if (!websiteUri) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(websiteUri, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'BoostlyLinkResearch/1.0' },
    });
    const html = await res.text();
    const urls = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map((m) => {
        try {
          return new URL(m[1], res.url).toString();
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const socialHosts = [
      'facebook.com',
      'instagram.com',
      'tiktok.com',
      'youtube.com',
      'x.com',
      'twitter.com',
      'linkedin.com',
    ];
    return [...new Set(urls.filter((url) => socialHosts.some((host) => new URL(url).hostname.includes(host))))];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

(async () => {
  const candidates = queryArg ? await searchPlace(queryArg) : [];
  const placeId = placeIdArg || candidates[0]?.id;
  if (!placeId) {
    throw new Error('No place found for query');
  }
  const details = await getDetails(placeId);
  const websiteSocialCandidates = await fetchWebsiteLinks(details.websiteUri);
  console.log(JSON.stringify({
    input: { placeId: placeIdArg || undefined, query: queryArg || undefined },
    selectedPlaceId: placeId,
    searchCandidates: candidates,
    googlePublic: details,
    websiteSocialCandidates,
    notes: [
      'Google Places public details do not include a documented social links field.',
      'Treat websiteSocialCandidates as candidates until ownership verified before adding to Boostly.',
    ],
  }, null, 2));
})();
NODE
