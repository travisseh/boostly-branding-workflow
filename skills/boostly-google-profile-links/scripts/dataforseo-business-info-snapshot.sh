#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  dataforseo-business-info-snapshot.sh --place-id <google_place_id>

Loads DataForSEO credentials from known local integration files and prints a bounded
business-info summary. Credentials are never printed.
USAGE
}

PLACE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --place-id)
      PLACE_ID="${2:-}"
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

if [[ -z "$PLACE_ID" ]]; then
  usage
  exit 2
fi

node - "$PLACE_ID" <<'NODE'
const fs = require('node:fs');

const placeId = process.argv[2];

const credentialSources = [
  {
    label: 'boostly-branding env',
    path: `${process.env.HOME}/.config/boostly-branding/.env`,
    usernameRegex: /^DATAFORSEO_LOGIN="?([^"\n]+)"?/m,
    passwordRegex: /^DATAFORSEO_PASSWORD="?([^"\n]+)"?/m,
  },
  {
    label: 'gmr_enrichment legacy',
    path: '/Users/travisse/Programming/gmr_enrichment/fetchReviewsDataForSEO.js',
    usernameRegex: /const API_USERNAME = '([^']+)'/,
    passwordRegex: /const API_PASSWORD = '([^']+)'/,
  },
  {
    label: 'product2 review analyzer',
    path: '/Users/travisse/Programming/product2/shared/apps/review-analyzer-tool/fetch-reviews.js',
    usernameRegex: /username:\s*"([^"]+)"/,
    passwordRegex: /password:\s*"([^"]+)"/,
  },
];

function loadCredentials(source) {
  if (!fs.existsSync(source.path)) return null;
  const text = fs.readFileSync(source.path, 'utf8');
  const username = text.match(source.usernameRegex)?.[1];
  const password = text.match(source.passwordRegex)?.[1];
  if (!username || !password) return null;
  return { label: source.label, username, password };
}

async function postTask(creds) {
  const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const res = await fetch('https://api.dataforseo.com/v3/business_data/google/my_business_info/task_post', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        keyword: `place_id:${placeId}`,
        location_name: 'United States',
        language_name: 'English',
      },
    ]),
  });
  const body = await res.json();
  return { auth, res, body };
}

async function getTask(auth, taskId) {
  const res = await fetch(`https://api.dataforseo.com/v3/business_data/google/my_business_info/task_get/${taskId}`, {
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
  });
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const attempts = [];

  for (const source of credentialSources) {
    const creds = loadCredentials(source);
    if (!creds) continue;
    const posted = await postTask(creds);
    const task = posted.body.tasks?.[0];
    attempts.push({
      label: creds.label,
      username: creds.username,
      httpStatus: posted.res.status,
      apiStatus: posted.body.status_code,
      taskStatus: task?.status_code,
      taskMessage: task?.status_message,
      taskId: task?.id,
    });

    if (!task?.id || task.status_code === 40200) continue;

    let item = null;
    let lastTask = null;
    for (let i = 0; i < 10; i++) {
      await sleep(i === 0 ? 5000 : 3000);
      const got = await getTask(posted.auth, task.id);
      lastTask = got.tasks?.[0];
      item = lastTask?.result?.[0]?.items?.[0] || null;
      if (item) break;
    }

    if (item) {
      console.log(JSON.stringify({
        input: { placeId },
        credentialSource: creds.label,
        attempts,
        itemKeys: Object.keys(item),
        socialFieldKeys: Object.keys(item).filter((key) => /social|facebook|instagram|twitter|tiktok|youtube|linkedin/i.test(key)),
        businessInfo: {
          title: item.title,
          place_id: item.place_id,
          cid: item.cid,
          domain: item.domain,
          url: item.url,
          contact_url: item.contact_url,
          contributor_url: item.contributor_url,
          book_online_url: item.book_online_url,
          address: item.address,
          phone: item.phone,
          category: item.category,
          is_claimed: item.is_claimed,
          rating: item.rating,
          local_business_links: item.local_business_links,
          attributes: item.attributes,
          servicesCount: Array.isArray(item.services) ? item.services.length : 0,
        },
        notes: [
          'DataForSEO my_business_info can expose richer public business data than Places.',
          'In tested output it did not expose direct social profile fields.',
        ],
      }, null, 2));
      return;
    }

    attempts[attempts.length - 1].lastTaskStatus = lastTask?.status_code;
    attempts[attempts.length - 1].lastTaskMessage = lastTask?.status_message;
  }

  console.log(JSON.stringify({
    input: { placeId },
    attempts,
    businessInfo: null,
  }, null, 2));
})();
NODE
