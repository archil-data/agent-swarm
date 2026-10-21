import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { Archil } from "disk";
import { Protocol } from "./protocol.mjs";
import { allGuards } from "./scope.mjs";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const root = fileURLToPath(new URL("../", import.meta.url));
export function settings(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      agents: { type: "string", default: "4" },
      initial: { type: "string" },
      minutes: { type: "string", default: "5" },
      budget: { type: "string", default: "5" },
      disk: { type: "string" },
      out: { type: "string", default: "artifacts" },
      brief: { type: "string" },
      model: {
        type: "string",
        default: process.env.SWARM_MODEL || "anthropic/claude-sonnet-5.5",
      },
      "max-requests": { type: "string", default: "128" },
    },
  });
  const config = {
    agents: Number(v.agents),
    initialWorkers: Number(v.initial || v.agents),
    minutes: Number(v.minutes),
    budgetUsd: Number(v.budget),
    maxModelRequests: Number(v["max-requests"]),
    maxOutputTokens: 4096,
    maxTurnsPerAgent: 80,
    region: process.env.ARCHIL_REGION || "aws-us-west-2",
    model: v.model,
  };
  if (
    !Number.isInteger(config.agents) ||
    config.agents < 1 ||
    config.agents > 128
  )
    throw Error("--agents must be 1..128");
  if (
    !Number.isInteger(config.initialWorkers) ||
    config.initialWorkers < 1 ||
    config.initialWorkers > config.agents
  )
    throw Error("--initial must be 1..agents");
  if (
    !(
      config.minutes > 0 &&
      config.minutes <= 60 &&
      Number.isFinite(config.budgetUsd) &&
      config.budgetUsd > 0 &&
      Number.isInteger(config.maxModelRequests) &&
      config.maxModelRequests > 0
    )
  )
    throw Error("Specify positive budget/max-requests and minutes <= 60");
  return { config, out: path.resolve(v.out), diskId: v.disk, brief: v.brief };
}
export async function prepare(api, brief, out) {
  // Read local inputs before allocating anything billable.
  const briefBytes = fs.readFileSync(
    brief || path.join(root, "examples/dashboard/BRIEF.md"),
  );
  const runtime = ["fs_tools.py", "records.py"].map((name) => [
    name,
    fs.readFileSync(path.join(root, "runtime", name)),
  ]);
  const { disk } = await api.disks.create({
    name: "agent-swarm-" + Date.now(),
  });
  try {
    fs.writeFileSync(
      path.join(out, "disk.json"),
      JSON.stringify({ diskId: disk.id }, null, 2),
    );
    for (const guard of allGuards())
      await disk.putObject(guard, "Permanent guard inode: do not replace.");
    for (const [name, bytes] of runtime)
      await disk.putObject("runtime/" + name, bytes);
    await disk.putObject("repo/BRIEF.md", briefBytes);
    return disk;
  } catch (error) {
    try {
      await disk.delete();
    } catch (cleanup) {
      console.error(
        "Preparation cleanup failed; disk retained: " +
          disk.id +
          ": " +
          String(cleanup),
      );
    }
    throw error;
  }
}
export async function conflict(remote) {
  const must = (x) => {
    if (!x.ok) throw Error(x.error);
    return x.result;
  };
  const call = async (a, o, args) =>
    remote.call(a, o, args, undefined, "conflict-demo");
  const file = "conflict-example.txt";
  const a = must(await call("alice", "acquire_lock", { path: file })).lock;
  const first = must(await call("alice", "read_file", { path: file }));
  must(
    await call("alice", "write_file", {
      path: file,
      token: a.token,
      expected_sha256: first.sha256,
      content: "base\n",
    }),
  );
  const stale = must(await call("alice", "read_file", { path: file }));
  const denied = must(await call("bob", "acquire_lock", { path: file }));
  if (denied.acquired) throw Error("Two owners acquired one lease");
  must(await call("alice", "release_lock", { path: file, token: a.token }));
  const b = must(await call("bob", "acquire_lock", { path: file })).lock;
  must(
    await call("bob", "write_file", {
      path: file,
      token: b.token,
      expected_sha256: stale.sha256,
      content: "base\nbob\n",
    }),
  );
  must(await call("bob", "release_lock", { path: file, token: b.token }));
  const oldToken = await call("alice", "write_file", {
    path: file,
    token: a.token,
    expected_sha256: stale.sha256,
    content: "lost update\n",
  });
  if (oldToken.ok) throw Error("Expired ownership token was accepted");
  const again = must(await call("alice", "acquire_lock", { path: file })).lock;
  const rejected = await call("alice", "write_file", {
    path: file,
    token: again.token,
    expected_sha256: stale.sha256,
    content: "lost update\n",
  });
  if (rejected.ok) throw Error("Stale source version was accepted");
  const current = must(await call("alice", "read_file", { path: file }));
  must(
    await call("alice", "write_file", {
      path: file,
      token: again.token,
      expected_sha256: current.sha256,
      content: current.content + "alice\n",
    }),
  );
  must(await call("alice", "release_lock", { path: file, token: again.token }));
  const final = must(await call("bob", "read_file", { path: file }));
  if (final.content !== "base\nbob\nalice\n")
    throw Error("Peer contribution was lost");
  return {
    lockContentionRejected: true,
    oldOwnershipRejected: true,
    staleVersionRejected: true,
    rereadAndAdaptSucceeded: true,
    finalContent: final.content,
    note: "Scripted protocol test, not model-authored agent activity",
  };
}
async function exportDisk(disk, out) {
  for (const prefix of ["repo/", "run/"])
    for (const obj of (await disk.listObjects(prefix, { recursive: true }))
      .objects) {
      if (obj.key.endsWith("/")) continue;
      const target = path.resolve(out, obj.key);
      if (!target.startsWith(out + path.sep))
        throw Error("Invalid exported path");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await disk.getObject(obj.key)));
    }
}
export async function main(
  argv = process.argv.slice(2),
  {
    createApi = (config) => new Archil({ region: config.region }),
    buildBundle = build,
  } = {},
) {
  const [command = "run", ...args] = argv,
    { config, out, diskId, brief } = settings(args);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(out); // A fresh directory prevents mixing runs or following old symlinks.
  if (!process.env.ARCHIL_API_KEY) throw Error("Set ARCHIL_API_KEY");
  const api = createApi(config);
  if (command === "export") {
    if (!diskId) throw Error("export requires --disk");
    await exportDisk(await api.disks.get(diskId), out);
    return;
  }
  if (!["run", "conflict"].includes(command))
    throw Error("Expected run, conflict, or export");
  if (command === "run" && !process.env.OPENROUTER_API_KEY)
    throw Error("Set OPENROUTER_API_KEY");
  if (command === "run") {
    const models = createModels();
    models.setProvider(openrouterProvider());
    if (!models.getModel("openrouter", config.model))
      throw Error("Model absent from the pinned Pi catalog: " + config.model);
  }
  if (diskId)
    throw Error(
      "run/conflict create a fresh isolated disk; --disk is only for export",
    );
  let disk, sandbox, cleanupPromise, shutdownTimer, interrupted;
  const checkInterrupted = () => {
    if (interrupted) throw Error("Interrupted by " + interrupted);
  };
  const cleanup = () =>
    (cleanupPromise ||= (async () => {
      if (!sandbox) return;
      for (const operation of ["stop", "delete"]) {
        try {
          await sandbox[operation]();
        } catch (e) {
          console.error(
            "Coordinator " +
              operation +
              " failed for " +
              sandbox.id +
              ": " +
              String(e),
          );
          process.exitCode = 1;
        }
      }
    })());
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    console.error(
      signal +
        ": stopping the coordinator and exporting available artifacts (30s limit).",
    );
    shutdownTimer = setTimeout(() => process.exit(process.exitCode), 30000);
    if (sandbox) void cleanup();
  };
  const interrupt = () => onSignal("SIGINT"),
    terminate = () => onSignal("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const log = (type, row) =>
    fs.appendFileSync(
      path.join(out, "controller-events.jsonl"),
      JSON.stringify({ type, at: Date.now() / 1000, ...row }) + "\n",
    );
  try {
    disk = await prepare(api, brief, out);
    config.diskId = disk.id;
    fs.writeFileSync(
      path.join(out, "disk.json"),
      JSON.stringify({ diskId: disk.id, region: config.region }, null, 2),
    );
    checkInterrupted();
    if (command === "conflict") {
      const result = await conflict(new Protocol(config, log));
      fs.writeFileSync(
        path.join(out, "conflict-result.json"),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify({ diskId: disk.id, ...result }));
      return;
    }
    const bundle = await buildBundle({
      entryPoints: [path.join(root, "src/cloud-entry.mjs")],
      write: false,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
      },
    });
    checkInterrupted();
    await disk.putObject("runtime/harness.mjs", bundle.outputFiles[0].contents);
    await disk.putObject("runtime/config.json", JSON.stringify(config));
    checkInterrupted();
    sandbox = await api.sandboxes.create({
      name: "agent-swarm-harness",
      baseImage: "node:24-bookworm-slim",
      vcpuCount: 4,
      memSizeMiB: 4096,
      maxTtlSeconds: Math.ceil(config.minutes * 60) + 300,
      idleTtlSeconds: 0,
      mounts: [{ disk, path: "/mnt/archil", conditional: true }],
    });
    fs.writeFileSync(
      path.join(out, "coordinator.json"),
      JSON.stringify({ coordinatorId: sandbox.id }, null, 2),
    );
    checkInterrupted();
    const proc = await sandbox.run("node /mnt/archil/runtime/harness.mjs", {
      env: {
        ARCHIL_API_KEY: process.env.ARCHIL_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      },
      onOutput: (e) => process.stdout.write(Buffer.from(e.data)),
    });
    console.log(
      JSON.stringify({
        diskId: disk.id,
        coordinatorId: sandbox.id,
        agents: config.agents,
      }),
    );
    const completed = await proc.wait();
    if (completed.exitCode !== 0) process.exitCode = 1;
  } finally {
    try {
      await cleanup();
      if (disk) {
        await exportDisk(disk, out);
        console.log(
          "Artifacts saved to " + out + "; disk retained: " + disk.id,
        );
      }
    } finally {
      clearTimeout(shutdownTimer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
