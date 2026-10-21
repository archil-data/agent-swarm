import importlib.util, subprocess, sys, tempfile, unittest, threading, time, json
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))
spec = importlib.util.spec_from_file_location("fs_tools", ROOT / "runtime/fs_tools.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        m.ROOT = Path(self.tmp.name)
        m.REPO = m.ROOT / "repo"
        m.COORD = m.ROOT / "coord"
        m.REPO.mkdir()
        (m.REPO / "BRIEF.md").write_text("One shared coding task.")
        self.seq = 0
        real = subprocess.run
        self.mock = patch.object(
            m.subprocess,
            "run",
            lambda argv, *a, **k: (
                subprocess.CompletedProcess(argv, 0)
                if argv[0] == "archil"
                else real(argv, *a, **k)
            ),
        )
        self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.tmp.cleanup()

    def call(self, who, op, **args):
        self.seq += 1
        return m.execute({"agent": who, "op": op, "args": args, "call": str(self.seq)})[
            "result"
        ]

    def task(self, id):
        return {
            "id": id,
            "title": id,
            "description": "Agent-chosen work",
            "files": ["value.mjs", "tests/value.test.mjs"],
            "dependencies": [],
        }

    def write(self, who, path, content):
        lock = self.call(who, "acquire_lock", path=path)["lock"]
        prior = self.call(who, "read_file", path=path)
        result = self.call(
            who,
            "write_file",
            path=path,
            token=lock["token"],
            expected_sha256=prior["sha256"],
            content=content,
        )
        self.call(who, "release_lock", path=path, token=lock["token"])
        return result

    def test_any_worker_creates_and_claims_without_leader(self):
        self.assertEqual(self.call("a", "list_tasks")["tasks"], [])
        self.call("b", "create_task", task=self.task("implementation"))
        claim = self.call("c", "claim_task", task_id="implementation")["task"]
        self.assertEqual(claim["owner"], "c")
        self.assertIsNone(
            self.call("b", "claim_task", task_id="implementation")["task"]
        )
        self.assertEqual(
            self.call("a", "read_task", task_id="implementation")["task"][
                "description"
            ],
            "Agent-chosen work",
        )

    def test_ownership_and_stale_hash_are_separate_checks(self):
        a = self.call("a", "acquire_lock", path="value.mjs")["lock"]
        self.assertFalse(self.call("b", "acquire_lock", path="value.mjs")["acquired"])
        old = self.call(
            "a",
            "write_file",
            path="value.mjs",
            token=a["token"],
            expected_sha256=None,
            content="export const value=1;",
        )
        self.call("a", "release_lock", path="value.mjs", token=a["token"])
        b = self.call("b", "acquire_lock", path="value.mjs")["lock"]
        self.call(
            "b",
            "write_file",
            path="value.mjs",
            token=b["token"],
            expected_sha256=old["sha256"],
            content="export const value=2;",
        )
        with self.assertRaisesRegex(ValueError, "fenced"):
            self.call(
                "a",
                "write_file",
                path="value.mjs",
                token=a["token"],
                expected_sha256=old["sha256"],
                content="lost update",
            )
        self.call("b", "release_lock", path="value.mjs", token=b["token"])
        again = self.call("a", "acquire_lock", path="value.mjs")["lock"]
        self.assertGreater(again["token"], a["token"])
        with self.assertRaisesRegex(ValueError, "changed since"):
            self.call(
                "a",
                "write_file",
                path="value.mjs",
                token=again["token"],
                expected_sha256=old["sha256"],
                content="lost update",
            )
        current = self.call("a", "read_file", path="value.mjs")
        self.call(
            "a",
            "write_file",
            path="value.mjs",
            token=again["token"],
            expected_sha256=current["sha256"],
            content=current["content"] + "\nexport const peer=3;",
        )
        self.assertEqual(
            self.call("b", "read_file", path="value.mjs")["content"],
            "export const value=2;\nexport const peer=3;",
        )

    def test_expired_leader_cannot_declare_ready(self):
        leader = self.call("a", "elect_leader")["leader"]
        m.put(m.COORD / "leader.json", {**leader, "expiresAt": 0})
        with self.assertRaisesRegex(ValueError, "stale"):
            self.call(
                "a",
                "declare_ready",
                term=leader["term"],
                test_call_id="none",
                summary="bad",
            )
        self.assertTrue(self.call("b", "elect_leader")["won"])

    def test_receipts_cover_actual_current_artifacts(self):
        self.call("a", "create_task", task=self.task("implementation"))
        claim = self.call("b", "claim_task", task_id="implementation")["task"]
        self.write("b", "value.mjs", "export const value=7;")
        self.write(
            "b",
            "tests/value.test.mjs",
            "import{test}from'node:test';import assert from'node:assert/strict';import{value}from'../value.mjs';test('value',()=>assert.equal(value,7));",
        )
        proof = self.call("b", "run_tests", test_files=[])
        self.assertEqual(proof["exitCode"], 0)
        self.assertTrue(proof["stableSnapshot"])
        m.put(m.COORD / "test-receipts" / f"{proof['testCallId']}.json", proof)
        self.write("b", "value.mjs", "export const value=8;")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.call(
                "b",
                "complete_task",
                task_id="implementation",
                claim_token=claim["claimToken"],
                test_call_id=proof["testCallId"],
                summary="bad",
            )
        self.assertNotEqual(self.call("b", "run_tests", test_files=[])["exitCode"], 0)

    def test_unguarded_record_mutation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "scope"):
            m.execute(
                {
                    "agent": "a",
                    "op": "create_task",
                    "args": {"task": self.task("bad")},
                    "call": "bad",
                    "guardPaths": [],
                }
            )

    def test_peer_dependency_changes_invalidate_explicit_full_suite(self):
        for dependency in ["value.mjs", ".value.mjs"]:
            with self.subTest(dependency=dependency):
                (m.REPO / dependency).write_text("export const value=1;")
                marker = m.ROOT / "test-started"
                marker.unlink(missing_ok=True)
                tests = m.REPO / "tests"
                tests.mkdir(exist_ok=True)
                (tests / "value.test.mjs").write_text(
                    "import{test}from'node:test';import assert from'node:assert/strict';"
                    f"import{{value}}from'../{dependency}';import fs from'node:fs';"
                    "test('value',async()=>{assert.equal(value,1);"
                    f"fs.writeFileSync({json.dumps(str(marker))},'ready');"
                    "await new Promise(r=>setTimeout(r,300));});"
                )

                def mutate():
                    end = time.monotonic() + 5
                    while not marker.exists() and time.monotonic() < end:
                        time.sleep(0.01)
                    if marker.exists():
                        (m.REPO / dependency).write_text("export const value=2;")

                peer = threading.Thread(target=mutate)
                peer.start()
                proof = self.call("a", "run_tests", test_files=["tests/value.test.mjs"])
                peer.join(timeout=6)
                self.assertTrue(marker.exists(), proof["stderr"])
                self.assertEqual(proof["exitCode"], 0)
                self.assertTrue(proof["executionSnapshot"])
                self.assertIn(dependency, proof["beforeFiles"])
                self.assertFalse(proof["stableSnapshot"])

    def test_tests_run_on_private_recorded_bytes_and_detect_self_changes(self):
        tests = m.REPO / "tests"
        tests.mkdir()
        (m.REPO / ".value.mjs").write_text("export const value=1;")
        (tests / "value.test.mjs").write_text(
            "import{test}from'node:test';import assert from'node:assert/strict';"
            "import fs from'node:fs';test('private',()=>{"
            f"assert.notEqual(process.cwd(),{json.dumps(str(m.REPO))});"
            "fs.writeFileSync('.value.mjs','export const value=2;');});"
        )
        proof = self.call("a", "run_tests", test_files=[])
        self.assertEqual(proof["exitCode"], 0)
        self.assertFalse(proof["stableSnapshot"])
        self.assertEqual((m.REPO / ".value.mjs").read_text(), "export const value=1;")

    def test_snapshot_rejects_symlinks_instead_of_omitting_inputs(self):
        (m.REPO / "link.mjs").symlink_to(m.REPO / "BRIEF.md")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.call("a", "run_command", command="true")

    def test_traversal_and_brief_mutation_are_rejected(self):
        for p in ["../secret", "/etc/passwd", "BRIEF.md"]:
            with self.assertRaises(ValueError):
                self.call("a", "acquire_lock", path=p)


if __name__ == "__main__":
    unittest.main()
