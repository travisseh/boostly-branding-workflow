#!/usr/bin/env python3
"""Apple Notes quick view of every open pre-physical fulfillment request.

Reads live open requests (read-only V2 query), joins each to its run.json under the run
root, derives the review steps, and replaces the body of one Apple Note with real rich
text (bold headings, bullets, links). Each location carries its Review page, latest
Compare page and Figma section links. Review pages are served from a local static
server on 127.0.0.1 so the links are clickable on this Mac. View only: the note is
rebuilt from state, so edits made in Notes are overwritten. No production writes.

Usage:
  review-checklist.py --run-root <dir> [--no-note] [--no-live] [--port 3917]
                      [--note-title "<title>"]
Files (all under <run-root>/checklist/): notes.json (optional one-line note per run dir
name), open-requests.json, checklist.json, checklist.md.
"""
import json, os, subprocess, sys, glob, datetime, re

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

def live_requests():
    out = os.path.join(HERE, "open-requests.json")
    if "--no-live" not in sys.argv:
        p = subprocess.run(["npx", "tsx", LIST_SCRIPT, "--status", "open", "--after", "2026-09-01T00:00:00Z",
                            "--json", "--run-root", RUNS], cwd=ROOT, capture_output=True, text=True, timeout=120)
        if p.returncode == 0 and p.stdout.strip().startswith("{"):
            open(out, "w").write(p.stdout)
        else:
            return json.load(open(out))["requests"], "STALE (live query failed; showing last good list)"
    return json.load(open(out))["requests"], None

def load_runs():
    runs = {}
    for f in glob.glob(os.path.join(RUNS, "*", "run.json")):
        try:
            j = json.load(open(f))
        except Exception:
            continue
        rid = (j.get("request") or {}).get("request_id")
        if rid:
            runs[rid] = (os.path.basename(os.path.dirname(f)), j)
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
    applied = bw.get("status") == "applied"
    links = j.get("links") or {}
    lc = [c for c in (links.get("candidates") or []) if isinstance(c, dict)]
    links_applied = links.get("applied") in (True, "True")
    holds = [c for c in lc if c.get("action") == "hold"]
    ready = [c for c in lc if c.get("action") == "ready"]
    fig = j.get("figma") or {}
    fstat = str(fig.get("status") or "")
    built = fstat.startswith("built") or bool(fig.get("section_node_id"))
    approved = fstat == "built_approved" or bool(fig.get("approved"))
    slack0 = bool((j.get("slack") or {}).get("message_ts") or (j.get("slack") or {}).get("posted_at"))
    # a Slack result is only ever posted after Travisse approved the signage (protocol since 2026-09-29),
    # so a posted run counts as approved even when branding complete was skipped (HOLD.md example sets).
    legacy = built and not approved and slack0 and past_digital
    if built and not approved and slack0 and not past_digital:
        approved = True
    if legacy:
        approved = True
    slack = bool((j.get("slack") or {}).get("message_ts") or (j.get("slack") or {}).get("posted_at"))
    notion = bool((j.get("notion") or {}).get("page_id"))
    lbl = "Branding pick" + (f": {picked}" if picked else (f" (Fable default {bv.get('fable_default_letter')})" if sheet else ""))
    if src:
        lbl += " [account-level, from " + os.path.basename(src) + "]"
    item["steps"] = [
        ["Review sheet ready", sheet],
        [lbl, bool(picked)],
        ["Branding applied in prod", applied],
        [f"Links written ({len(ready)} ready, {len(holds)} need a call)" if not links_applied else f"Links written ({len(holds)} still held)", links_applied],
        ["Figma signage built", built],
        ["Figma approved by you" + (" (closed out before the approval step existed)" if legacy else ""), approved],
        ["Slack result posted", slack],
        ["Notion updated", notion],
        ["Store details confirmed", confirmed],
    ]
    if not sheet and not src:
        item["needs_you"].append("not started: pipeline has not produced a review sheet")
    elif not picked:
        item["needs_you"].append("pick a letter")
    elif built and not approved:
        item["needs_you"].append("approve the Figma signage")
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
    figs = [i for i in items if has(i, "approve the Figma")]
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
    section("Approve Figma signage", figs, lambda i: f"**{i['name']}**:{note(i)}{fig(i)}")
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
    text = render(items, stale, notes)
    json.dump({"generated_at": datetime.datetime.now().isoformat(), "stale": stale, "items": items},
              open(os.path.join(HERE, "checklist.json"), "w"), indent=1)
    open(os.path.join(HERE, "checklist.txt"), "w").write(text)
    if "--no-note" in sys.argv:
        print(text); return
    md = os.path.join(HERE, "checklist.md")
    open(md, "w").write(text)
    p = subprocess.run(["python3", WRITER, "--input", md, "--replace-title", NOTE_TITLE], capture_output=True, text=True, timeout=90)
    if p.returncode != 0 and "not found" in (p.stdout + p.stderr):
        p = subprocess.run(["python3", WRITER, "--input", md, "--folder", "Notes", "--create"], capture_output=True, text=True, timeout=90)
    print("writer exit", p.returncode, "|", (p.stdout.strip() or p.stderr.strip())[:400])
    print(f"items={len(items)} needs_you={sum(1 for i in items if i['needs_you'] and not i.get('done'))} stale={bool(stale)}")

main()
