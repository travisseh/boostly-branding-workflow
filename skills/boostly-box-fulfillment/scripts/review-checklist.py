#!/usr/bin/env python3
"""Status board for every open pre-physical fulfillment request (Travisse 2026-10-13: the
statuses live on the hosted review site, not in Notion or an Apple Note).

Reads live open requests (read-only V2 query), joins each to its run.json under the run
root, derives the review steps and what Travisse owes, and writes checklist.json. With
--publish-status it also uploads a public-safe copy (no ship-to data, no local paths) to
the Vercel Blob store behind https://fulfillment-reviews.vercel.app, where the index and
every location page overlay it live. The launchd job does this every 5 minutes. Each run
dir may carry review/status.json (written by review-status.mjs: status waiting|done,
waiting_on, ease); it is folded into the item. No production writes.

Usage:
  review-checklist.py --run-root <dir> [--publish-status] [--no-live] [--port 3917]
                      [--note] [--note-title "<title>"]
--note rewrites the legacy Apple Note (off by default since 2026-10-13); --no-note is
accepted and ignored. Files (all under <run-root>/checklist/): notes.json (optional
one-line note per run dir name), open-requests.json, checklist.json, checklist.txt.
"""
import json, os, subprocess, sys, glob, datetime, re, time, urllib.request, urllib.parse, urllib.error

def _arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else default

RUNS = os.path.abspath(_arg("--run-root") or os.environ.get("BOOSTLY_RUN_ROOT") or "")
if not _arg("--run-root") and not os.environ.get("BOOSTLY_RUN_ROOT"):
    sys.exit("review-checklist.py: pass --run-root <dir> (the folder that holds one run dir per location)")
ROOT = os.path.dirname(RUNS)
HERE = os.path.join(RUNS, "checklist")
os.makedirs(HERE, exist_ok=True)
NOTE_TITLE = _arg("--note-title", "Fulfillment reviews: pre-physical checklist")
PORT = int(_arg("--port", "3917"))
BASE = f"http://127.0.0.1:{PORT}"
PRE_PHYSICAL = ["branding", "digital_fulfillment", "store_details"]
LIST_SCRIPT = os.path.expanduser("~/.claude/skills/boostly-box-fulfillment/scripts/list-branding-requests.ts")
NOTES_TOOL = os.path.expanduser("~/.claude/tools/apple-notes.py")
WRITER = os.path.expanduser("~/.claude/skills/apple-notes-decision-brief/scripts/write_decision_brief.py")
SITE = os.environ.get("BOOSTLY_REVIEWS_SITE", "https://fulfillment-reviews.vercel.app")
REVIEWS_REPO = os.environ.get("BOOSTLY_REVIEWS_REPO_DIR") or os.path.expanduser("~/Programming/repos/fulfillment-reviews")
STATUS_KEY = "status/checklist.json"

def load_review_status(run_dir):
    """review/status.json written by boostly-brand-design/scripts/review-status.mjs (status, waiting_on, ease)."""
    try:
        j = json.load(open(os.path.join(RUNS, run_dir, "review", "status.json")))
        return j if isinstance(j, dict) else None
    except Exception:
        return None

def blob_token():
    t = os.environ.get("BLOB_READ_WRITE_TOKEN")
    if t:
        return t
    envf = os.path.join(REVIEWS_REPO, ".env.local")
    if os.path.exists(envf):
        m = re.search(r'^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?', open(envf).read(), re.M)
        if m:
            return m.group(1)
    return None

PUBLIC_FIELDS = ["request_id", "name", "status", "created", "run_dir", "steps", "needs_you", "gaps", "hold", "done",
                 "figma_url", "note", "review_status", "progress", "site_url"]

def load_progress(run_dir):
    """review/progress.json written by boostly-brand-design/scripts/run-progress.mjs (stage, last_step,
    next_step, blocked_on, by, host, updated_at, bundle). Also published per slug to status/<slug>.json."""
    try:
        j = json.load(open(os.path.join(RUNS, run_dir, "review", "progress.json")))
        if not isinstance(j, dict):
            return None
        keep = ["stage", "last_step", "next_step", "blocked_on", "by", "host", "updated_at"]
        out = {k: j.get(k) for k in keep}
        if isinstance(j.get("bundle"), dict):
            out["bundle_pushed_at"] = j["bundle"].get("pushed_at")
        return out
    except Exception:
        return None

def publish_host():
    """Short machine name stamped on each published item and in the top-level publishers map."""
    import socket
    return (os.environ.get("BOOSTLY_PUBLISH_HOST") or socket.gethostname() or "unknown").split(".")[0]

def publish_disabled():
    """BOOSTLY_PUBLISH_STATUS=0 (environment, or the shared env file that launchd does not source) turns the
    Blob PUT off on this machine: a dry-run or test machine never touches the shared board."""
    v = os.environ.get("BOOSTLY_PUBLISH_STATUS")
    if v is None:
        envf = os.environ.get("BOOSTLY_BRANDING_ENV_FILE") or os.path.expanduser("~/.config/boostly-branding/.env")
        try:
            with open(envf) as f:
                m = re.search(r'^(?:export\s+)?BOOSTLY_PUBLISH_STATUS="?([^"\n]*)"?', f.read(), re.M)
            v = m.group(1) if m else None
        except Exception:
            v = None
    return str(v).strip().lower() in ("0", "false", "no", "off")

def is_dry_run_note(note):
    return isinstance(note, str) and note.strip().lower().startswith("dry run")

def is_dry_run(run_dir, notes):
    """A run dir with a DRY_RUN marker file, or whose notes.json line starts with "Dry run", is never published."""
    if not run_dir:
        return False
    return os.path.exists(os.path.join(RUNS, run_dir, "DRY_RUN")) or is_dry_run_note((notes or {}).get(run_dir))

def item_mtime(run_dir):
    """Per-item updated_at: newest mtime of the files that move an item (run.json, review status/progress, HOLD.md)."""
    if not run_dir:
        return None
    best = 0.0
    for rel in ("run.json", "HOLD.md", os.path.join("review", "status.json"), os.path.join("review", "progress.json")):
        try:
            best = max(best, os.path.getmtime(os.path.join(RUNS, run_dir, rel)))
        except OSError:
            pass
    if not best:
        return None
    return datetime.datetime.fromtimestamp(best, datetime.timezone.utc).isoformat(timespec="seconds")

def _ts(v):
    if not isinstance(v, str) or not v:
        return None
    try:
        d = datetime.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.astimezone()
    return d.timestamp()

def best_ts(item):
    """progress.updated_at, then review_status.updated_at, then the item's own updated_at."""
    for v in ((item.get("progress") or {}).get("updated_at"), (item.get("review_status") or {}).get("updated_at"),
              item.get("updated_at")):
        t = _ts(v)
        if t is not None:
            return t
    return None

def _done_steps(item):
    return sum(1 for s in (item.get("steps") or []) if isinstance(s, (list, tuple)) and len(s) > 1 and s[1])

def _newer(a, b):
    ta, tb = best_ts(a), best_ts(b)
    if ta is None:
        return False
    return tb is None or ta > tb

def merge_pair(local, remote):
    """One location seen by both machines. done never downgrades; fewer completed steps never wins unless strictly
    newer and not a dry run; otherwise newer wins (ties go to this machine). Nulls never replace values."""
    ld, rd = bool(local.get("done")), bool(remote.get("done"))
    if ld != rd:
        win = local if ld else remote
    else:
        nl, nr = _done_steps(local), _done_steps(remote)
        if nl < nr:
            win = local if (_newer(local, remote) and not is_dry_run_note(local.get("note"))) else remote
        elif nr < nl:
            win = remote if (_newer(remote, local) and not is_dry_run_note(remote.get("note"))) else local
        else:
            win = remote if _newer(remote, local) else local
    other = remote if win is local else local
    out = dict(win)
    for k in ("progress", "review_status", "figma_url"):
        if out.get(k) is None and other.get(k) is not None:
            out[k] = other[k]
    return out

def _key(item):
    return item.get("run_dir") or ("req:" + item["request_id"] if item.get("request_id") else "name:" + str(item.get("name")))

def merge_board(local_items, remote_items, stale):
    """Merge this machine's items into the board already on Blob, per location (request_id, then run_dir, then name).
    Remote-only items stay unless this machine's live list is fresh and does not contain them; remote dry runs drop."""
    by_req = {i["request_id"]: i for i in local_items if i.get("request_id")}
    by_dir = {i["run_dir"]: i for i in local_items if i.get("run_dir")}
    by_name = {i.get("name"): i for i in local_items}
    merged = {_key(i): i for i in local_items}
    order = [_key(i) for i in local_items]
    for r in remote_items or []:
        if not isinstance(r, dict) or is_dry_run_note(r.get("note")):
            continue
        l = (by_req.get(r.get("request_id")) if r.get("request_id") else None) or \
            (by_dir.get(r.get("run_dir")) if r.get("run_dir") else None) or \
            (by_name.get(r.get("name")) if not r.get("request_id") and not r.get("run_dir") else None)
        if l is not None:
            merged[_key(l)] = merge_pair(merged[_key(l)], r)
        elif stale:
            k = _key(r)
            if k not in merged:
                merged[k] = r
                order.append(k)
        # fresh live list without this location: it closed or moved past pre-physical, so it drops
    items = [merged[k] for k in order]
    items.sort(key=lambda i: (i.get("created") or "", i.get("name") or ""))
    return items

def fetch_remote_board(token):
    """Current status/checklist.json from Blob (list for the URL, then a cache-busted GET). Returns (payload, error);
    a missing or empty board is ({}, None), anything else unreadable is (None, error) and the PUT is skipped."""
    q = urllib.parse.urlencode({"prefix": STATUS_KEY, "limit": "10"})
    req = urllib.request.Request("https://blob.vercel-storage.com/?" + q, headers={
        "authorization": "Bearer " + token, "x-api-version": "7"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            blobs = json.loads(r.read().decode()).get("blobs") or []
    except Exception as e:
        return None, f"list failed {type(e).__name__}"
    url = next((b.get("url") for b in blobs if b.get("pathname") == STATUS_KEY), None)
    if not url:
        return {}, None
    try:
        with urllib.request.urlopen(url + "?t=" + str(int(time.time() * 1000)), timeout=60) as r:
            raw = r.read().decode().strip()
    except urllib.error.HTTPError as e:
        return ({}, None) if e.code == 404 else (None, f"GET HTTP {e.code}")
    except Exception as e:
        return None, f"GET failed {type(e).__name__}"
    if not raw:
        return {}, None
    try:
        j = json.loads(raw)
    except ValueError:
        return None, "GET returned non-JSON"
    return (j if isinstance(j, dict) else {}), None

def put_board(token, body):
    req = urllib.request.Request("https://blob.vercel-storage.com/" + STATUS_KEY, data=body, method="PUT", headers={
        "authorization": "Bearer " + token, "x-api-version": "7", "x-content-type": "application/json",
        "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-cache-control-max-age": "60",
        "content-length": str(len(body))})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return "ok " + json.loads(r.read().decode()).get("url", "")
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code} {e.read()[:200].decode(errors='replace')}"
    except Exception as e:
        return f"failed {type(e).__name__}: {e}"

def publish_status(items, stale, notes=None):
    """Merge this machine's public-safe items into the board on Vercel Blob (fixed key, 60 s edge cache) and PUT
    the result. Two machines publish (Travisse's and Karissa's launchd jobs), so a whole-file overwrite would
    erase the other side; the merge is idempotent, so a same-minute race heals on the next run. Never prints the
    token. Dry runs never publish: BOOSTLY_PUBLISH_STATUS=0 skips the PUT, DRY_RUN / "Dry run" items are left out."""
    if publish_disabled():
        return "skipped (BOOSTLY_PUBLISH_STATUS=0: dry-run machine, the shared board is left alone)"
    token = blob_token()
    if not token:
        return "no BLOB_READ_WRITE_TOKEN (env or " + os.path.join(REVIEWS_REPO, ".env.local") + ")"
    host = publish_host()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    local = []
    for i in items:
        if is_dry_run(i.get("run_dir"), notes) or is_dry_run_note(i.get("note")):
            continue
        p = {k: i.get(k) for k in PUBLIC_FIELDS}
        p["updated_at"] = i.get("updated_at") or item_mtime(i.get("run_dir"))
        p["host"] = host
        local.append(p)
    remote, err = fetch_remote_board(token)
    if remote is None:
        return f"skipped (could not read the current board: {err}; not overwriting it)"
    publishers = dict(remote.get("publishers") or {}) if isinstance(remote.get("publishers"), dict) else {}
    publishers[host] = now
    payload = {"generated_at": now, "stale": bool(stale), "site": SITE, "publishers": publishers,
               "items": merge_board(local, remote.get("items") or [], stale)}
    body = json.dumps(payload, separators=(",", ":")).encode()
    assert b"ship_to" not in body and b"street" not in body.lower()
    return put_board(token, body)

def live_requests():
    out = os.path.join(HERE, "open-requests.json")
    # --no-live trusts the cached list only while it is fresh: the 5-minute launchd job refreshes it, and on a
    # machine where that job is not loaded an old cache hid new requests from the board (Karissa 2026-10-21)
    cache_old = not os.path.exists(out) or time.time() - os.path.getmtime(out) > 900
    if "--no-live" not in sys.argv or cache_old:
        p = subprocess.run(["npx", "tsx", LIST_SCRIPT, "--status", "open", "--after", "2026-09-01T00:00:00Z",
                            "--json", "--run-root", RUNS], cwd=ROOT, capture_output=True, text=True, timeout=120)
        if p.returncode == 0 and p.stdout.strip().startswith("{"):
            open(out, "w").write(p.stdout)
        else:
            return json.load(open(out))["requests"], "STALE (live query failed; showing last good list)"
    return json.load(open(out))["requests"], None

def run_progress(d, j):
    """How far a run dir got: recorded stages, then pipeline blocks, then a review canvas. Used to pick one dir
    when two share a request id (a re-seeded stub next to the real run, e.g. Surfin' Betty's Downtown 2026-10-15)."""
    stages = len(((j.get("state") or {}).get("stages") or {}))
    blocks = sum(1 for k in ("variants", "write", "links", "figma", "slack") if j.get(k))
    canvas = os.path.exists(os.path.join(RUNS, d, "review", "review-canvas.html"))
    return (stages + blocks, canvas, d)

def load_runs():
    runs = {}
    for f in sorted(glob.glob(os.path.join(RUNS, "*", "run.json"))):
        try:
            j = json.load(open(f))
        except Exception:
            continue
        rid = (j.get("request") or {}).get("request_id")
        if not rid:
            continue
        d = os.path.basename(os.path.dirname(f))
        # two dirs for one request: the one with more progress wins, never whichever glob listed last
        if rid in runs and run_progress(*runs[rid]) >= run_progress(d, j):
            continue
        runs[rid] = (d, j)
    return runs

def by_dir(runs, name):
    for d, j in runs.values():
        if d == name:
            return j
    return None

def rebuild_canvas(run_dir, canvas_html):
    """Rebuild a review page that has link data but no Links section. Never opens anything. True when fixed."""
    script = os.path.expanduser("~/.claude/skills/boostly-brand-design/scripts/review-canvas.mjs")
    if not os.path.exists(script):
        return False
    try:
        backup = canvas_html.replace(".html", ".before-links-rebuild.html")
        if not os.path.exists(backup):
            with open(canvas_html, "rb") as a, open(backup, "wb") as b:
                b.write(a.read())
        subprocess.run(["node", script, "--run", run_dir, "--skip-google"], capture_output=True, timeout=300)
        return 'id="links"' in open(canvas_html, encoding="utf-8", errors="ignore").read()
    except Exception:
        return False

def derive(req, runs):
    rid = req.get("fulfillment_request_id")
    cands = req.get("location_candidates") or [{}]
    name = cands[0].get("location_name") or "(unknown location)"
    item = {"request_id": rid, "name": name, "status": req.get("status"), "created": (req.get("created_at") or "")[:10],
            "run_dir": None, "steps": [], "needs_you": [], "gaps": [], "hold": None}
    ship = (req.get("shipping") or {}).get("complete")
    if not ship:
        item["gaps"].append("ship-to missing")
    confirmed = bool(req.get("store_details_confirmed_at"))
    past_digital = req.get("status") == "store_details"
    seeded_only = rid in runs and not (runs[rid][1].get("variants") or runs[rid][1].get("write") or runs[rid][1].get("links"))
    if rid not in runs or (seeded_only and past_digital):
        if past_digital:
            item["steps"] = [["Branding and links (done outside this run folder)", True], ["Store details confirmed", confirmed]]
            item["needs_you"].append("confirm store details (ship-to, quantities)")
        else:
            item["steps"] = [["Pipeline run (evidence, variants, links)", False]]
            item["needs_you"].append("not started: tell the lead to run it")
        return item
    d, j = runs[rid]
    item["run_dir"] = d
    w = j.get("write") or {}
    v = j.get("variants") or {}
    src = w.get("branding_source_run")
    inherited = None
    if src:
        inherited = by_dir(runs, os.path.basename(src))
        bw = (inherited or {}).get("write") or {}
        bv = (inherited or {}).get("variants") or {}
    else:
        bw, bv = w, v
    picked = bw.get("picked_letter") or bw.get("applied_letter") or bv.get("applied_letter")
    if picked in (None, "None"):
        picked = None
    sheet = bool(bv.get("sheet_png"))
    # applied means THIS location's own write landed (applied, or applied+inherited for a sibling). A sibling
    # whose source run is applied but whose own write is held/pending is not applied in prod yet.
    applied = w.get("status") in ("applied", "applied+inherited")
    links = j.get("links") or {}
    lc = [c for c in (links.get("candidates") or []) if isinstance(c, dict)]
    links_applied = links.get("applied") in (True, "True")
    holds = [c for c in lc if c.get("action") == "hold"]
    ready = [c for c in lc if c.get("action") == "ready"]
    fig = j.get("figma") or {}
    fstat = str(fig.get("status") or "")
    # signage is built either as a Figma section (until 2026-10-15) or as the direct PDF render (the default
    # since then, run.json signage.direct with its review-sheets.png preview); Travisse approves whichever exists
    direct = (j.get("signage") or {}).get("direct") or {}
    dstat = str(direct.get("status") or "")
    built = fstat.startswith("built") or bool(fig.get("section_node_id")) or dstat.startswith("built") or bool(direct.get("preview_png"))
    approved = fstat == "built_approved" or bool(fig.get("approved")) or dstat == "built_approved" or bool(direct.get("approved"))
    slack0 = bool((j.get("slack") or {}).get("message_ts") or (j.get("slack") or {}).get("posted_at"))
    # a Slack result is only ever posted after Travisse approved the signage (protocol since 2026-09-29),
    # so a posted run counts as approved even when branding complete was skipped (HOLD.md example sets).
    legacy = built and not approved and slack0 and past_digital
    if built and not approved and slack0 and not past_digital:
        approved = True
    if legacy:
        approved = True
    slack = bool((j.get("slack") or {}).get("message_ts") or (j.get("slack") or {}).get("posted_at"))
    site_status = load_review_status(d)
    # status posted to the review site (review/status.json); a legacy Notion entry counts for runs closed before 2026-10-13
    site_posted = bool(site_status) or bool((j.get("notion") or {}).get("page_id"))
    lbl = "Branding pick" + (f": {picked}" if picked else (f" (Fable default {bv.get('fable_default_letter')})" if sheet else ""))
    if src:
        lbl += " [account-level, from " + os.path.basename(src) + "]"
    item["steps"] = [
        ["Review sheet ready", sheet],
        [lbl, bool(picked)],
        ["Branding applied in prod", applied],
        [f"Links written ({len(ready)} ready, {len(holds)} need a call)" if not links_applied else f"Links written ({len(holds)} still held)", links_applied],
        ["Signage built" + (" (direct PDF)" if dstat else " (Figma)" if fstat else ""), built],
        ["Signage approved by you" + (" (closed out before the approval step existed)" if legacy else ""), approved],
        ["Slack result posted", slack],
        ["Status posted to the review site", site_posted],
        ["Store details confirmed", confirmed],
    ]
    if not sheet and not src:
        item["needs_you"].append("not started: pipeline has not produced a review sheet")
    elif not picked:
        item["needs_you"].append("pick a letter")
    elif built and not approved:
        item["needs_you"].append("approve the signage" + (" (print files in Drive)" if dstat and not fstat else " (Figma)" if fstat else ""))
    if holds and not links_applied:
        item["needs_you"].append(f"{len(holds)} link decision(s)")
    elif ready and not links_applied and built and approved and slack:
        # closed out but the ready links were never authorized: that is a decision for Travisse, not agent work
        item["needs_you"].append(f"{len(ready)} link decision(s) (ready links waiting on your go)")
    if past_digital and not confirmed:
        item["needs_you"].append("confirm store details (ship-to, quantities)")
    hp = os.path.join(RUNS, d, "HOLD.md")
    if os.path.exists(hp):
        lines = [l.strip("#-* ").strip() for l in open(hp).read().splitlines() if l.strip()]
        lines = [l for l in lines if not l.upper().startswith("HOLD")] or lines
        item["hold"] = (lines[0] if lines else "HOLD")[:160]
    item["review_status"] = site_status
    item["progress"] = load_progress(d)
    item["site_url"] = f"{SITE}/{d}/"
    rv = (bv.get("review_canvas") or {})
    item["canvas"] = os.path.join(RUNS, os.path.basename(src) if src else d, "review", "review-canvas.html") if sheet else None
    item["figma_url"] = fig.get("section_url")
    ldir = os.path.basename(src) if src else d
    rdir = os.path.join(RUNS, ldir, "review")
    canvas_html = os.path.join(rdir, "review-canvas.html")
    item["review_url"] = f"{BASE}/{ldir}/review/review-canvas.html" if os.path.exists(canvas_html) else None
    # Links section (Travisse 2026-09-29): a location with link candidates must show them on its review
    # page. A page built before the links existed is rebuilt once here; the note then links straight to it.
    item["links_url"] = None
    if item["review_url"]:
        has_links = 'id="links"' in open(canvas_html, encoding="utf-8", errors="ignore").read()
        cands = (j.get("links") or {}).get("candidates") or []
        if not has_links and cands and not src:
            has_links = rebuild_canvas(os.path.join(RUNS, ldir), canvas_html)
        if has_links and not src:  # a sibling's links are not on the source run's page
            item["links_url"] = item["review_url"] + "#links"
    sheet_png = os.path.join(RUNS, ldir, "variants", "variant-sheet.png")
    item["sheet_url"] = f"{BASE}/{ldir}/variants/variant-sheet.png" if os.path.exists(sheet_png) else None
    comps = sorted(glob.glob(os.path.join(rdir, "compare-*.html")), key=os.path.getmtime)
    item["compare_url"] = f"{BASE}/{ldir}/review/{os.path.basename(comps[-1])}" if comps else None
    if not item["figma_url"] and inherited:
        item["figma_url"] = (inherited.get("figma") or {}).get("section_url")
    skipped = (j.get("state") or {}).get("branding_complete") == "skipped"
    if skipped:
        # branding complete withheld on purpose (HOLD.md): store details and physical never apply to this run
        item["steps"] = [[n, True] if n == "Store details confirmed" else [n, v] for n, v in item["steps"]]
        item["needs_you"] = [n for n in item["needs_you"] if not n.startswith("confirm store details")]
    item["done"] = all(s[1] for s in item["steps"])
    return item

def render(items, stale, notes):
    """Markdown quick view, grouped by what Travisse owes. Rendered to rich text by the Notes writer."""
    now = datetime.datetime.now().strftime("%a %b %-d, %-I:%M %p")
    def nm(i):
        return re.sub(r"\s*\([^)]*\)\s*$", "", i["name"]) if False else i["name"]
    def has(i, key):
        return any(key in n for n in i["needs_you"])
    def note(i):
        n = notes.get(i.get("run_dir") or "")
        return (" " + n) if n else ""
    def fig(i):
        return lk(i)
    def lk(i):
        parts = []
        if i.get("review_url"): parts.append(f"[Review page]({i['review_url']})")
        elif i.get("sheet_url"): parts.append(f"[Variant sheet]({i['sheet_url']}) (review page still building)")
        if i.get("links_url"): parts.append(f"[Links]({i['links_url']})")
        if i.get("compare_url"): parts.append(f"[Compare]({i['compare_url']})")
        if i.get("figma_url"): parts.append(f"[Figma]({i['figma_url']})")
        return (" " + " · ".join(parts)) if parts else ""
    picks = [i for i in items if has(i, "pick a letter")]
    figs = [i for i in items if has(i, "approve the signage")]
    links = [i for i in items if has(i, "link decision")]
    store = [i for i in items if has(i, "store details")]
    notstarted = [i for i in items if has(i, "not started")]
    waiting = [i for i in items if not i["needs_you"] and not i.get("done")]
    done = [i for i in items if i.get("done")]
    L = ["# " + NOTE_TITLE,
         f"**Updated {now}** · refreshes every 5 min · view only",
         f"**{len(picks)}** picks · **{len(figs)}** Figma approvals · **{len(links)}** with link decisions · **{len(store)}** store details · **{len(notstarted)}** not reviewable yet"]
    if stale:
        L.append("**WARNING:** " + stale)
    def section(title, group, fmt):
        if not group:
            return
        L.append("")
        L.append(f"## {title} ({len(group)})")
        for i in group:
            L.append("- " + fmt(i))
    section("Pick a letter", picks, lambda i: f"**{i['name']}**:{note(i) or ' review sheet is ready.'}{lk(i)}")
    section("Approve signage", figs, lambda i: f"**{i['name']}**:{note(i)}{fig(i)}")
    def linkfmt(i):
        n = next(x for x in i["needs_you"] if "link decision" in x)
        return f"**{i['name']}**: {n.replace('(s)', 's')}{lk(i)}"
    section("Link decisions", links, linkfmt)
    section("Confirm store details", store, lambda i: f"**{i['name']}**" + (": " + ", ".join(i["gaps"]) if i["gaps"] else ": ship-to on file, needs confirmation"))
    section("Not reviewable yet", notstarted, lambda i: f"**{i['name']}**:{note(i) or ' pipeline has not produced a review sheet.'}")
    def waitfmt(i):
        nxt = next((s for s, ok in i["steps"] if not ok), "")
        return f"**{i['name']}**:{note(i) or ' next is ' + nxt.lower() + '.'}{lk(i)}"
    section("In progress with the agents, nothing for you", waiting, waitfmt)
    section("Review complete", done, lambda i: f"**{i['name']}**")
    L.append("")
    L.append("## By location")
    for i in items:
        dn = sum(1 for s, ok in i["steps"] if ok)
        nxt = next((s for s, ok in i["steps"] if not ok), "all steps done")
        L.append(f"- **{i['name']}** ({dn}/{len(i['steps'])}): next is {nxt[0].lower() + nxt[1:]}.{lk(i)}")
    L.append("")
    L.append("_Source: live open requests plus each run folder's record. Status covers branding, digital fulfillment and store details only._")
    return "\n".join(L)

def ensure_server():
    import socket
    k = socket.socket()
    try:
        k.settimeout(0.5); k.connect(("127.0.0.1", PORT)); k.close(); return
    except Exception:
        pass
    subprocess.Popen(["python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", RUNS],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def main():
    ensure_server()
    reqs, stale = live_requests()
    runs = load_runs()
    reqs = [r for r in reqs if r.get("status") in PRE_PHYSICAL]
    items = [derive(r, runs) for r in reqs]
    items.sort(key=lambda i: (i["created"], i["name"]))
    try:
        notes = json.load(open(os.path.join(HERE, "notes.json")))
    except Exception:
        notes = {}
    for i in items:
        i["note"] = notes.get(i.get("run_dir") or "") or None
    text = render(items, stale, notes)
    json.dump({"generated_at": datetime.datetime.now().isoformat(), "stale": stale, "items": items},
              open(os.path.join(HERE, "checklist.json"), "w"), indent=1)
    open(os.path.join(HERE, "checklist.txt"), "w").write(text)
    if "--publish-status" in sys.argv:
        print("status published:", publish_status(items, stale, notes))
    print(f"items={len(items)} needs_you={sum(1 for i in items if i['needs_you'] and not i.get('done'))} stale={bool(stale)}")
    if "--note" not in sys.argv:
        return
    md = os.path.join(HERE, "checklist.md")
    open(md, "w").write(text)
    p = subprocess.run(["python3", WRITER, "--input", md, "--replace-title", NOTE_TITLE], capture_output=True, text=True, timeout=90)
    if p.returncode != 0 and "not found" in (p.stdout + p.stderr):
        p = subprocess.run(["python3", WRITER, "--input", md, "--folder", "Notes", "--create"], capture_output=True, text=True, timeout=90)
    print("writer exit", p.returncode, "|", (p.stdout.strip() or p.stderr.strip())[:400])

if __name__ == "__main__":
    main()
