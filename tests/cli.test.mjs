import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, main } from "../src/cli.mjs";

test("bad local input allocates no disk; failed uploads save the recovery ID and delete the disk", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-setup-"));
  let created = 0,
    deleted = 0;
  const api = {
    disks: {
      create: async () => {
        created++;
        return {
          disk: {
            id: "fixture-only",
            putObject: async () => {
              throw Error("upload failed");
            },
            delete: async () => {
              deleted++;
            },
          },
        };
      },
    },
  };
  try {
    await assert.rejects(
      prepare(api, path.join(out, "missing.md"), out),
      /ENOENT/,
    );
    assert.equal(created, 0);
    await assert.rejects(prepare(api, undefined, out), /upload failed/);
    assert.equal(created, 1);
    assert.equal(deleted, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(out, "disk.json"))).diskId,
      "fixture-only",
    );
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("controller interruption stops and deletes the coordinator and exports available artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-interrupt-")),
    out = path.join(dir, "artifacts");
  const oldArchil = process.env.ARCHIL_API_KEY,
    oldRouter = process.env.OPENROUTER_API_KEY,
    oldCode = process.exitCode;
  process.env.ARCHIL_API_KEY = "fixture-only";
  process.env.OPENROUTER_API_KEY = "fixture-only";
  const operations = [];
  let release;
  const disk = {
    id: "fixture-only",
    putObject: async () => {},
    listObjects: async (prefix) => {
      operations.push("export:" + prefix);
      return { objects: [] };
    },
  };
  const sandbox = {
    id: "fixture-coordinator",
    stop: async () => {
      operations.push("stop");
      release({ exitCode: 0 });
    },
    delete: async () => {
      operations.push("delete");
    },
    run: async () => ({
      wait: () =>
        new Promise((resolve) => {
          release = resolve;
          queueMicrotask(() => process.emit("SIGINT"));
        }),
    }),
  };
  try {
    await main(["run", "--out", out], {
      createApi: () => ({
        disks: { create: async () => ({ disk }) },
        sandboxes: { create: async () => sandbox },
      }),
      buildBundle: async () => ({
        outputFiles: [{ contents: Buffer.from("// fixture only") }],
      }),
    });
    assert.deepEqual(operations, [
      "stop",
      "delete",
      "export:repo/",
      "export:run/",
    ]);
    assert.equal(process.exitCode, 130);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(out, "coordinator.json")))
        .coordinatorId,
      sandbox.id,
    );
  } finally {
    process.exitCode = oldCode;
    for (const [key, value] of [
      ["ARCHIL_API_KEY", oldArchil],
      ["OPENROUTER_API_KEY", oldRouter],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
