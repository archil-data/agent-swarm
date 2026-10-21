import { test } from "node:test";
import assert from "node:assert/strict";
import { Protocol } from "../src/protocol.mjs";
import { guardPaths } from "../src/scope.mjs";
import { settings, conflict } from "../src/cli.mjs";
test("SDK adapter uses scoped checkouts for edits and read-only execution for commands", async () => {
  const requests = [],
    writes = [];
  const r = new Protocol({ diskId: "fixture", region: "aws-us-west-2" });
  r.api = {
    exec: async (request) => {
      requests.push(request);
      return {
        stdout: JSON.stringify({ ok: true, result: {} }),
        timing: { executeMs: 1 },
      };
    },
    disks: { get: async () => ({ putObject: async (...x) => writes.push(x) }) },
  };
  await r.call("a", "write_file", {
    path: "state.js",
    token: 1,
    expected_sha256: null,
    content: "x",
  });
  const mount = requests[0].disks.workspace;
  assert.equal(mount.conditional, true);
  assert.deepEqual(
    mount.checkoutPaths,
    guardPaths("write_file", { path: "state.js" }),
  );
  assert(mount.checkoutPaths.every((x) => x.startsWith("coord/guards/files-")));
  await r.call("a", "run_command", { command: "pwd" });
  assert.deepEqual(requests[1].disks.workspace, {
    disk: "fixture",
    readOnly: true,
  });
  assert.equal(writes.length, 1);
});
test("configuration rejects invalid scale and budgets", () => {
  assert.throws(() => settings(["--agents", "0"]));
  assert.throws(() => settings(["--agents", "129"]));
  assert.throws(() => settings(["--budget", "NaN"]));
  assert.throws(() => settings(["--agents", "4", "--initial", "5"]));
  assert.equal(settings([]).config.agents, 4);
});
test("conflict fixture refuses a backend that accepts concurrent ownership", async () => {
  const backend = {
    call: async (a, o, args) => ({
      ok: true,
      result:
        o === "acquire_lock"
          ? { acquired: true, lock: { token: 1 } }
          : { sha256: "x", content: "x" },
    }),
  };
  await assert.rejects(() => conflict(backend), /Two owners/);
});

test("out-of-order tool completions cannot regress task versions or leadership observations", async () => {
  const r = new Protocol({ diskId: "fixture", region: "aws-us-west-2" }),
    pending = [];
  r.api = { exec: () => new Promise((resolve) => pending.push(resolve)) };
  const old = r.call("a", "list_tasks"),
    current = r.call("a", "list_tasks");
  pending[1]({
    stdout: JSON.stringify({
      ok: true,
      serverTime: 3,
      leader: { owner: "new" },
      result: { tasks: [{ id: "task", version: 2, status: "done" }] },
    }),
    timing: { executeMs: 1 },
  });
  await current;
  pending[0]({
    stdout: JSON.stringify({
      ok: true,
      serverTime: 2,
      leader: { owner: "old" },
      result: { tasks: [{ id: "task", version: 1, status: "working" }] },
    }),
    timing: { executeMs: 1 },
  });
  await old;
  assert.equal(r.tasks.get("task").status, "done");
  assert.equal(r.leader.owner, "new");
});
