#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

AE_REST_BASE = "https://app.askelephant.ai/api/v2"
AE_GRAPHQL_URL = "https://app.askelephant.ai/graphql"
DEFAULT_PERSON = "travisse@boostly.com"
DEFAULT_WORKSPACE_ID = "wrks_01JNKRAD8B3QJVT7CZPPPNMTRZ"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def load_default_env() -> None:
    for path in [
        Path.cwd() / ".env",
        Path.cwd() / ".env.local",
        Path.home() / ".config/boostly-branding/.env",
    ]:
        load_env_file(path)


def parse_date_range(args: argparse.Namespace) -> tuple[dt.datetime, dt.datetime]:
    now = dt.datetime.now(dt.timezone.utc)
    local_tz = dt.datetime.now().astimezone().tzinfo

    def is_date_only(value: str | None) -> bool:
        return bool(value and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value))

    if args.date:
        if args.date == "yesterday":
            local_day = dt.datetime.now(local_tz).date() - dt.timedelta(days=1)
        elif args.date == "today":
            local_day = dt.datetime.now(local_tz).date()
        else:
            local_day = dt.date.fromisoformat(args.date)
        start_local = dt.datetime.combine(local_day, dt.time.min, tzinfo=local_tz)
        end_local = start_local + dt.timedelta(days=1)
        return start_local.astimezone(dt.timezone.utc), end_local.astimezone(dt.timezone.utc)

    if args.since:
        start = dt.datetime.fromisoformat(args.since)
        if start.tzinfo is None:
            start = start.replace(tzinfo=local_tz)
        start = start.astimezone(dt.timezone.utc)
    else:
        start = now - dt.timedelta(days=args.days)

    if args.until:
        if is_date_only(args.since) and args.since == args.until:
            local_day = dt.date.fromisoformat(args.until)
            end = dt.datetime.combine(local_day + dt.timedelta(days=1), dt.time.min, tzinfo=local_tz)
        else:
            end = dt.datetime.fromisoformat(args.until)
            if end.tzinfo is None:
                end = end.replace(tzinfo=local_tz)
        end = end.astimezone(dt.timezone.utc)
    else:
        end = now

    return start, end


def request_json(url: str, headers: dict[str, str], data: dict | None = None) -> dict:
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "accept": "application/json",
            **({"content-type": "application/json"} if data is not None else {}),
            **headers,
        },
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode())


def firebase_id_token() -> str | None:
    refresh_token = os.getenv("ASKELEPHANT_REFRESH_TOKEN")
    api_key = os.getenv("ASKELEPHANT_FIREBASE_API_KEY")
    if not refresh_token or not api_key:
        return None
    url = f"https://securetoken.googleapis.com/v1/token?key={urllib.parse.quote(api_key)}"
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode())
    return payload.get("id_token")


def rest_headers() -> dict[str, str] | None:
    api_key = os.getenv("ASKELEPHANT_API_KEY")
    if api_key:
        return {"authorization": api_key}
    return None


def has_rest_auth() -> bool:
    return bool(os.getenv("ASKELEPHANT_API_KEY"))


def has_graphql_auth() -> bool:
    return bool(os.getenv("ASKELEPHANT_REFRESH_TOKEN") and os.getenv("ASKELEPHANT_FIREBASE_API_KEY"))


def database_url() -> str | None:
    return os.getenv("SALES_DATABASE_URL") or os.getenv("DATABASE_URL")


def psql_env(db_url: str) -> dict[str, str]:
    parsed = urllib.parse.urlparse(db_url)
    params = urllib.parse.parse_qs(parsed.query)
    env = os.environ.copy()
    sales_database_host = os.getenv("SALES_DATABASE_HOST")
    if sales_database_host or parsed.hostname:
        env["PGHOST"] = sales_database_host or parsed.hostname
    if parsed.port:
        env["PGPORT"] = str(parsed.port)
    if parsed.username:
        env["PGUSER"] = urllib.parse.unquote(parsed.username)
    if parsed.password:
        env["PGPASSWORD"] = urllib.parse.unquote(parsed.password)
    dbname = parsed.path.lstrip("/") or (urllib.parse.unquote(parsed.username) if parsed.username else "")
    if dbname:
        env["PGDATABASE"] = dbname
    env["PGSSLMODE"] = params.get("sslmode", ["require"])[0]
    env["PGAPPNAME"] = "askelephant_reporting_read"
    env.setdefault("PGOPTIONS", "-c default_transaction_read_only=on")
    return env


def assert_read_replica(db_url: str) -> None:
    proc = subprocess.run(
        ["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT pg_is_in_recovery();"],
        env=psql_env(db_url),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr.strip() or "read replica check failed").replace(db_url, "[database_url]"))
    if proc.stdout.strip() != "t":
        raise RuntimeError("Refusing transcript search: configured database is not a PostgreSQL read replica.")


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def fetch_db_engagements(start: dt.datetime, end: dt.datetime, limit: int) -> list[dict]:
    db_url = database_url()
    if not db_url:
        return []

    assert_read_replica(db_url)

    sql = f"""
    SELECT COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::jsonb)
    FROM (
      SELECT
        transcripts.source_engagement_id AS id,
        transcripts.source_url,
        transcripts.title,
        transcripts.started_at AS start_at,
        transcripts.ended_at AS end_at,
        transcripts.duration_seconds,
        jsonb_build_object(
          'name', transcripts.owner_name,
          'email', transcripts.owner_email,
          'emails', CASE
            WHEN transcripts.owner_email IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(transcripts.owner_email)
          END
        ) AS owner,
        jsonb_build_object('name', transcripts.host_name) AS host,
        (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('name', tag_name)), '[]'::jsonb)
          FROM unnest(transcripts.source_tag_names) AS tag_name
        ) AS tags,
        transcripts.participants,
        (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('email', email)), '[]'::jsonb)
          FROM unnest(transcripts.external_emails) AS email
        ) AS contacts,
        bodies.transcript_text AS transcript
      FROM reporting.call_transcripts transcripts
      JOIN reporting.call_transcript_bodies bodies
        ON bodies.call_transcript_id = transcripts.id
      WHERE transcripts.source = 'askelephant'
        AND transcripts.has_transcript = true
        AND bodies.transcript_text IS NOT NULL
        AND transcripts.started_at >= {sql_literal(start.isoformat())}::timestamptz
        AND transcripts.started_at <= {sql_literal(end.isoformat())}::timestamptz
      ORDER BY transcripts.started_at DESC
      LIMIT {int(limit)}
    ) rows;
    """

    proc = subprocess.run(
        ["psql", "-At", "-c", sql],
        env=psql_env(db_url),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr.strip() or "psql query failed").replace(db_url, "[database_url]"))

    rows = json.loads(proc.stdout.strip() or "[]")
    for row in rows:
        if row.get("start_at") is not None:
            row["start_at"] = str(row["start_at"])
        if row.get("end_at") is not None:
            row["end_at"] = str(row["end_at"])
    return rows


def fetch_rest_engagements(start: dt.datetime, end: dt.datetime, limit: int) -> list[dict]:
    headers = rest_headers()
    if not headers:
        return []

    engagements: list[dict] = []
    cursor = None
    while len(engagements) < limit:
        params = urllib.parse.urlencode({
            "limit": min(100, limit - len(engagements)),
            "expand": "tags,companies,contacts,owner,transcript",
            "order_by": "updated_at:desc",
            "filter[start_at][gte]": start.isoformat().replace("+00:00", "Z"),
            "filter[start_at][lte]": end.isoformat().replace("+00:00", "Z"),
            **({"cursor": cursor} if cursor else {}),
        })
        page = request_json(f"{AE_REST_BASE}/engagements?{params}", headers)
        engagements.extend(page.get("data") or [])
        cursor = page.get("next_cursor")
        if not page.get("has_more") or not cursor:
            break
    return engagements


def fetch_graphql_engagements(start: dt.datetime, end: dt.datetime, limit: int) -> list[dict]:
    token = firebase_id_token()
    if not token:
        return []

    query = """
    query SkillSearchEngagements($first: Int!, $after: String, $filter: EngagementFilter, $sort: [EngagementSort!]) {
      viewer {
        currentWorkspace {
          engagements(first: $first, after: $after, filter: $filter, sort: $sort) {
            edges {
              cursor
              node {
                id
                title
                startAt
                endAt
                duration
                isRecorded
                hasTranscript
                transcriptText
                tags { id name }
                companies { id displayName primaryDomain }
                allParticipants {
                  edges {
                    node { id __typename displayName primaryEmail isUser }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
    """
    variables = {
        "first": min(100, limit),
        "after": None,
        "filter": {
            "isRecorded": True,
            "startAt": start.isoformat().replace("+00:00", "Z"),
        },
        "sort": ["DATE_DESC"],
    }
    headers = {"authorization": f"Bearer {token}"}
    engagements: list[dict] = []
    while len(engagements) < limit:
        variables["first"] = min(100, limit - len(engagements))
        payload = request_json(AE_GRAPHQL_URL, headers, {"query": query, "variables": variables})
        if payload.get("errors"):
            raise RuntimeError(json.dumps(payload["errors"]))
        connection = payload["data"]["viewer"]["currentWorkspace"]["engagements"]
        for edge in connection.get("edges") or []:
            node = edge["node"]
            normalized = normalize_graphql_engagement(node)
            started = parse_iso(normalized.get("start_at"))
            if started and started < start:
                return engagements
            if started and started <= end:
                engagements.append(normalized)
        page_info = connection.get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            break
        variables["after"] = page_info.get("endCursor")
    return engagements


def normalize_graphql_engagement(node: dict) -> dict:
    participants = [
        edge.get("node") for edge in ((node.get("allParticipants") or {}).get("edges") or [])
        if isinstance(edge, dict) and isinstance(edge.get("node"), dict)
    ]
    return {
        "id": node.get("id"),
        "title": node.get("title"),
        "start_at": node.get("startAt"),
        "end_at": node.get("endAt"),
        "duration_seconds": parse_duration_seconds(node.get("duration")),
        "owner": None,
        "host": None,
        "tags": node.get("tags") or [],
        "companies": [
            {
                "id": company.get("id"),
                "name": company.get("displayName"),
                "domains": [company.get("primaryDomain")] if company.get("primaryDomain") else [],
            }
            for company in (node.get("companies") or [])
            if isinstance(company, dict)
        ],
        "contacts": node.get("contacts") or [],
        "participants": participants,
        "transcript": node.get("transcriptText"),
    }


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_duration_seconds(value: str | None) -> int | None:
    if not value:
        return None
    total = 0
    for amount, unit in re.findall(r"(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)", value.lower()):
        n = int(amount)
        if unit.startswith("h"):
            total += n * 3600
        elif unit.startswith("m"):
            total += n * 60
        else:
            total += n
    return total or None


def emails_from_obj(value) -> list[str]:
    emails = []
    if isinstance(value, dict):
        for item in value.get("emails") or []:
            if isinstance(item, dict) and item.get("email"):
                emails.append(item["email"].lower())
            elif isinstance(item, str):
                emails.append(item.lower())
    return emails


def all_emails(engagement: dict) -> set[str]:
    emails: set[str] = set()
    for key in ["owner", "host"]:
        emails.update(emails_from_obj(engagement.get(key)))
    for key in ["contacts", "participants"]:
        for item in engagement.get(key) or []:
            emails.update(emails_from_obj(item))
            if isinstance(item, dict) and item.get("email"):
                emails.add(item["email"].lower())
            if isinstance(item, dict) and item.get("primaryEmail"):
                emails.add(item["primaryEmail"].lower())
    return emails


def matches_person(engagement: dict, person: str) -> bool:
    person = person.lower()
    if not person:
        return True
    if person in all_emails(engagement):
        return True
    localpart = person.split("@", 1)[0]
    text = json.dumps({
        "owner": engagement.get("owner"),
        "host": engagement.get("host"),
        "participants": engagement.get("participants"),
        "transcript": engagement.get("transcript"),
    }, default=str).lower()
    return person in text or (localpart and localpart in text)


def keyword_snippets(text: str, terms: list[str], max_snippets: int = 5) -> list[str]:
    if not text:
        return []
    clean = re.sub(r"\s+", " ", text)
    if not terms:
        return [clean[:900]]
    snippets = []
    lowered = clean.lower()
    for term in terms:
        idx = lowered.find(term.lower())
        if idx == -1:
            continue
        start = max(0, idx - 250)
        end = min(len(clean), idx + len(term) + 450)
        snippets.append(clean[start:end].strip())
        if len(snippets) >= max_snippets:
            break
    return snippets


def main() -> int:
    load_default_env()
    parser = argparse.ArgumentParser(description="Search AskElephant meetings/transcripts.")
    person_group = parser.add_mutually_exclusive_group()
    person_group.add_argument("--person", default=DEFAULT_PERSON, help="Filter meetings to this person/email. Defaults to Travisse.")
    person_group.add_argument("--all", action="store_true", help="Search all AskElephant meetings without person filtering.")
    parser.add_argument("--date", help="today, yesterday, or YYYY-MM-DD")
    parser.add_argument("--since")
    parser.add_argument("--until")
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--query", default="", help="Space-separated keyword terms.")
    parser.add_argument("--limit", type=int, default=20, help="Maximum matching meetings to return.")
    parser.add_argument("--fetch-limit", type=int, default=500, help="Maximum recent engagements to scan before local filtering.")
    parser.add_argument("--source", choices=["auto", "db", "live"], default="auto", help="Transcript source. auto tries the reporting DB first, then live AskElephant.")
    parser.add_argument("--include-transcript", action="store_true")
    args = parser.parse_args()

    start, end = parse_date_range(args)
    terms = [term for term in re.split(r"\s+", args.query.strip()) if term]

    engagements: list[dict] = []
    auth_mode = "none"
    source_status = "no_auth"
    rest_error = None

    if args.source in {"auto", "db"}:
        try:
            engagements = fetch_db_engagements(start, end, args.fetch_limit)
            auth_mode = "reporting_db"
            source_status = "db_ok" if engagements else "db_zero_results"
        except Exception as exc:
            rest_error = exc
            source_status = "db_failed"
            if args.source == "db":
                raise RuntimeError(f"Reporting DB transcript search failed: {exc}") from exc

    if args.source == "db":
        pass
    elif source_status in {"no_auth", "db_zero_results", "db_failed"} and has_rest_auth():
        try:
            engagements = fetch_rest_engagements(start, end, args.fetch_limit)
            auth_mode = "rest_api_key"
            source_status = "rest_ok" if engagements else "rest_zero_results"
        except Exception as exc:
            rest_error = exc
            source_status = "rest_failed"

    if args.source != "db" and source_status in {"no_auth", "db_zero_results", "db_failed", "rest_failed"}:
        if not has_graphql_auth():
            if rest_error:
                raise RuntimeError(f"Transcript search failed and GraphQL fallback credentials are unavailable: {rest_error}")
        else:
            try:
                engagements = fetch_graphql_engagements(start, end, args.fetch_limit)
                auth_mode = "graphql_refresh_token"
                source_status = "graphql_ok" if engagements else "graphql_zero_results"
            except Exception as exc:
                if rest_error:
                    raise RuntimeError(f"REST AskElephant search failed, then GraphQL fallback failed: {exc}") from exc
                raise

    person_filter = "" if args.all else args.person
    filtered = [eng for eng in engagements if matches_person(eng, person_filter)]
    if terms:
        filtered = [
            eng for eng in filtered
            if any(term.lower() in (eng.get("transcript") or "").lower() or term.lower() in (eng.get("title") or "").lower() for term in terms)
        ]

    output = {
        "auth_mode": auth_mode,
        "source_status": source_status,
        "scope": "all" if args.all else "person",
        "person": person_filter or None,
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "scanned": len(engagements),
        "count": len(filtered),
        "meetings": [],
    }

    for eng in filtered[: args.limit]:
        transcript = eng.get("transcript") or ""
        item = {
            "id": eng.get("id"),
            "url": f"https://app.askelephant.ai/workspaces/{DEFAULT_WORKSPACE_ID}/engagements/{eng.get('id')}",
            "title": eng.get("title"),
            "start_at": eng.get("start_at"),
            "duration_seconds": eng.get("duration_seconds"),
            "owner": eng.get("owner"),
            "host": eng.get("host"),
            "tags": [tag.get("name") for tag in (eng.get("tags") or []) if isinstance(tag, dict)],
            "companies": [company.get("name") for company in (eng.get("companies") or []) if isinstance(company, dict)],
            "participants": [
                {
                    "name": participant.get("displayName") or participant.get("name"),
                    "email": participant.get("primaryEmail") or participant.get("email"),
                    "is_user": participant.get("isUser"),
                }
                for participant in (eng.get("participants") or [])
                if isinstance(participant, dict)
            ],
            "contacts": [
                {
                    "name": " ".join(filter(None, [contact.get("first_name") or contact.get("firstName"), contact.get("last_name") or contact.get("lastName")])).strip(),
                    "emails": sorted(emails_from_obj(contact)),
                }
                for contact in (eng.get("contacts") or [])
                if isinstance(contact, dict)
            ],
            "snippets": keyword_snippets(transcript, terms),
        }
        if args.include_transcript:
            item["transcript"] = transcript
        output["meetings"].append(item)

    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"AskElephant search failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
