import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, hashes } from "../video/prepare.mjs";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-replay-"));
  fs.mkdirSync(root + "/repo/tests", { recursive: true });
  fs.mkdirSync(root + "/run/session-events", { recursive: true });
  fs.writeFileSync(
    root + "/repo/index.html",
    "<!doctype html><p>Fixture only</p>",
  );
  fs.writeFileSync(
    root + "/repo/tests/a.test.mjs",
    "import{test}from'node:test';import assert from'node:assert/strict';test('fixture',()=>assert.equal(1+1,2));",
  );
  const source = hashes(root + "/repo");
  const rows = [
    { type: "run_started", at: 0, agents: 4 },
    { type: "model_request", at: 1, agent: "agent-001" },
    {
      type: "exec_completed",
      at: 2,
      op: "run_tests",
      payload: {
        ok: true,
        result: {
          exitCode: 0,
          stableSnapshot: true,
          testQualityAccepted: true,
          files: source,
          testedFiles: ["tests/a.test.mjs"],
        },
      },
      timing: { executeMs: 1000 },
    },
    { type: "run_finished", at: 10 },
  ];
  fs.writeFileSync(
    root + "/run/session-events/fixture.jsonl",
    rows.map((x) => JSON.stringify(x)).join("\n"),
  );
  return { root, source };
}
test("unit results do not become browser acceptance or guessed CPU allocation", () => {
  const { root } = fixture();
  try {
    const result = prepare({ artifacts: root, out: root + "/replay" });
    assert.equal(result.nodeTestsPassed, true);
    assert.equal(result.browserAccepted, false);
    assert.equal(result.cpuVerified, false);
    assert.equal(
      fs.readFileSync(root + "/repo/index.html", "utf8"),
      fs.readFileSync(root + "/replay/game/index.html", "utf8"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("browser proof must match the exact final source", () => {
  const { root, source } = fixture();
  try {
    const proof = {
      stableSnapshot: true,
      sourceHashes: source,
      checks: { render: true, interaction: true },
      errors: [],
      warnings: [],
    };
    fs.writeFileSync(root + "/proof.json", JSON.stringify(proof));
    assert.equal(
      prepare({
        artifacts: root,
        out: root + "/verified",
        acceptance: root + "/proof.json",
        executionVcpu: 2,
      }).browserAccepted,
      true,
    );
    fs.writeFileSync(root + "/repo/index.html", "changed");
    assert.equal(
      prepare({
        artifacts: root,
        out: root + "/changed",
        acceptance: root + "/proof.json",
        executionVcpu: 2,
      }).browserAccepted,
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("hidden source inputs are covered and symlink sources are rejected", () => {
  const { root, source } = fixture();
  try {
    fs.writeFileSync(root + "/repo/.module.mjs", "export const value=1;");
    assert.notDeepEqual(hashes(root + "/repo"), source);
    assert.ok(hashes(root + "/repo")[".module.mjs"]);
    fs.symlinkSync(".module.mjs", root + "/repo/link.mjs");
    assert.throws(() => hashes(root + "/repo"), /regular files/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
