import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { prepare, main, bundleHarness } from "../src/cli.mjs";

test("production cloud bundle parses and excludes optional native clients even when locally installed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-bundle-"));
  try {
    const native = path.join(dir, "node_modules/@archildata/native");
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(
      path.join(native, "package.json"),
      JSON.stringify({
        name: "@archildata/native",
        type: "module",
        main: "index.js",
      }),
    );
    fs.writeFileSync(
      path.join(native, "index.js"),
      "import{createRequire}from'node:module';export const ArchilClient=createRequire(import.meta.url)('./platform.node');",
    );
    const result = await bundleHarness((options) =>
      build({ ...options, nodePaths: [path.join(dir, "node_modules")] }),
    );
    assert.ok(
      !Object.keys(result.metafile.inputs).some((input) =>
        input.includes("@archildata/native"),
      ),
    );
    const check = spawnSync(
      process.execPath,
      ["--check", "--input-type=module"],
      { input: result.outputFiles[0].contents, encoding: "utf8" },
    );
    assert.equal(check.status, 0, check.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
