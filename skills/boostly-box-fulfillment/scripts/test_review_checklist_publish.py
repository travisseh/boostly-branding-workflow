#!/usr/bin/env python3
"""Merge-publish tests for review-checklist.py (no network: fetch and put are monkeypatched).
Run: python3 -m unittest discover -s ~/.claude/skills/boostly-box-fulfillment/scripts -p 'test_review_checklist_publish.py' -v"""
import importlib.util, json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_TMP = tempfile.mkdtemp(prefix="checklist-test-")
os.environ["BOOSTLY_RUN_ROOT"] = os.path.join(_TMP, "runs")
os.makedirs(os.environ["BOOSTLY_RUN_ROOT"], exist_ok=True)
_argv = sys.argv
sys.argv = ["review-checklist.py"]
spec = importlib.util.spec_from_file_location("review_checklist", os.path.join(HERE, "review-checklist.py"))
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)
sys.argv = _argv


def item(run_dir, done=False, steps=None, progress_at=None, note=None, rid=None, **kw):
    steps = steps if steps is not None else [["Variant sheet built", True], ["Pick", done]]
    it = {"request_id": rid or "req-" + run_dir, "name": run_dir.title(), "status": "branding", "created": "2026-10-01",
          "run_dir": run_dir, "steps": steps, "needs_you": [] if done else ["pick a letter"], "gaps": [], "hold": None,
          "done": done, "figma_url": None, "note": note, "review_status": None,
          "progress": {"stage": "review", "updated_at": progress_at} if progress_at else None, "site_url": None}
    it.update(kw)
    return it


class PublishMergeTest(unittest.TestCase):
    def setUp(self):
        self.remote = {}
        self.puts = []
        self.saved = (rc.blob_token, rc.fetch_remote_board, rc.put_board, rc.publish_host)
        rc.blob_token = lambda: "test-token"
        rc.fetch_remote_board = lambda token: (self.remote, None)
        rc.put_board = lambda token, body: self.puts.append(json.loads(body)) or "ok test"
        rc.publish_host = lambda: "travisse-mac"
        os.environ.pop("BOOSTLY_PUBLISH_STATUS", None)
        os.environ["BOOSTLY_BRANDING_ENV_FILE"] = os.path.join(_TMP, "no-such.env")

    def tearDown(self):
        rc.blob_token, rc.fetch_remote_board, rc.put_board, rc.publish_host = self.saved
        os.environ.pop("BOOSTLY_PUBLISH_STATUS", None)

    def board(self):
        self.assertEqual(len(self.puts), 1)
        return {i["run_dir"] or i["name"]: i for i in self.puts[0]["items"]}

    def test_newer_wins(self):
        self.remote = {"items": [item("a", progress_at="2026-10-15T10:00:00Z", note="remote newer")]}
        rc.publish_status([item("a", progress_at="2026-10-15T09:00:00Z", note="local older")], None)
        self.assertEqual(self.board()["a"]["note"], "remote newer")
        self.puts.clear()
        self.remote = {"items": [item("a", progress_at="2026-10-15T08:00:00Z", note="remote older")]}
        rc.publish_status([item("a", progress_at="2026-10-15T09:00:00Z", note="local newer")], None)
        self.assertEqual(self.board()["a"]["note"], "local newer")

    def test_null_never_overwrites(self):
        prog = {"stage": "closeout", "updated_at": "2026-10-15T08:00:00Z"}
        self.remote = {"items": [item("a", figma_url="https://figma.example/x", review_status={"status": "waiting"},
                                      progress=prog)]}
        loc = item("a", figma_url=None, review_status=None, progress=None, updated_at="2026-10-15T12:00:00+00:00")
        rc.publish_status([loc], None)
        b = self.board()["a"]
        self.assertEqual(b["figma_url"], "https://figma.example/x")
        self.assertEqual(b["review_status"], {"status": "waiting"})
        self.assertEqual(b["progress"], prog)

    def test_done_never_downgrades(self):
        self.remote = {"items": [item("slice", done=True, progress_at="2026-10-14T21:39:34Z")]}
        rc.publish_status([item("slice", done=False, progress_at="2026-10-15T09:00:00Z")], None)
        b = self.board()["slice"]
        self.assertTrue(b["done"])
        self.assertEqual(b["needs_you"], [])

    def test_fewer_steps_needs_newer(self):
        more = [["a", True], ["b", True], ["c", False]]
        fewer = [["a", True], ["b", False], ["c", False]]
        self.remote = {"items": [item("a", steps=more, progress_at="2026-10-15T10:00:00Z", note="more")]}
        rc.publish_status([item("a", steps=fewer, progress_at="2026-10-15T09:00:00Z", note="fewer")], None)
        self.assertEqual(self.board()["a"]["note"], "more")

    def test_remote_only_kept_when_stale(self):
        self.remote = {"items": [item("karissa-only")]}
        rc.publish_status([item("a")], "STALE (live query failed; showing last good list)")
        self.assertIn("karissa-only", self.board())

    def test_stale_side_never_deletes_but_fresh_side_drops_closed(self):
        self.remote = {"items": [item("closed-elsewhere"), item("a")]}
        rc.publish_status([item("a")], None)
        b = self.board()
        self.assertNotIn("closed-elsewhere", b)
        self.assertIn("a", b)

    def test_remote_matched_by_request_id_across_run_dirs(self):
        self.remote = {"items": [item("karissa-dir", rid="R1", done=True, progress_at="2026-10-14T00:00:00Z")]}
        rc.publish_status([item("travisse-dir", rid="R1", steps=[["Pipeline run", False]])], None)
        items = self.puts[0]["items"]
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0]["done"])

    def test_dry_run_excluded(self):
        os.makedirs(os.path.join(rc.RUNS, "marker-run"), exist_ok=True)
        open(os.path.join(rc.RUNS, "marker-run", "DRY_RUN"), "w").close()
        self.remote = {"items": [item("remote-dry", note="Dry run on Karissa's Mac, ignore")]}
        rc.publish_status([item("marker-run"), item("note-run"), item("real")],
                          None, {"note-run": "Dry run on Karissa's Mac"})
        b = self.board()
        self.assertEqual(sorted(b), ["real"])

    def test_dry_run_remote_never_replaces_done(self):
        self.remote = {"items": [item("slice", note="Dry run on Karissa's Mac", progress_at="2026-10-15T23:00:00Z")]}
        rc.publish_status([item("slice", done=True, progress_at="2026-10-14T21:39:34Z")], None)
        self.assertTrue(self.board()["slice"]["done"])

    def test_env_switch_skips(self):
        os.environ["BOOSTLY_PUBLISH_STATUS"] = "0"
        out = rc.publish_status([item("a")], None)
        self.assertTrue(out.startswith("skipped"))
        self.assertEqual(self.puts, [])

    def test_env_file_switch_skips(self):
        envf = os.path.join(_TMP, "shared.env")
        with open(envf, "w") as f:
            f.write('FOO=1\nBOOSTLY_PUBLISH_STATUS=0\n')
        os.environ["BOOSTLY_BRANDING_ENV_FILE"] = envf
        self.assertTrue(rc.publish_status([item("a")], None).startswith("skipped"))
        self.assertEqual(self.puts, [])

    def test_unreadable_board_skips_put(self):
        rc.fetch_remote_board = lambda token: (None, "GET HTTP 500")
        self.assertTrue(rc.publish_status([item("a")], None).startswith("skipped"))
        self.assertEqual(self.puts, [])

    def test_host_publishers_and_idempotent(self):
        self.remote = {"publishers": {"karissa-mac": "2026-10-14T20:00:00+00:00"}, "items": [item("a")]}
        rc.publish_status([item("a")], None)
        first = self.puts[0]
        self.assertEqual(set(first["publishers"]), {"karissa-mac", "travisse-mac"})
        self.assertEqual(first["items"][0]["host"], "travisse-mac")
        self.remote = first
        self.puts.clear()
        rc.publish_status([item("a")], None)
        self.assertEqual(self.puts[0]["items"], first["items"])

    def test_no_ship_to_in_payload(self):
        rc.publish_status([item("a")], None)
        body = json.dumps(self.puts[0])
        self.assertNotIn("ship_to", body)
        self.assertNotIn("street", body.lower())


if __name__ == "__main__":
    unittest.main()
