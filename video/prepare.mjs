import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
const templateRoot = fileURLToPath(new URL("./", import.meta.url));
export function hashes(dir) {
  const result = {};
  function walk(folder) {
    for (const f of fs.readdirSync(folder, { withFileTypes: true })) {
      const p = path.join(folder, f.name);
      if (f.isSymbolicLink() || (!f.isDirectory() && !f.isFile()))
        throw Error(
          "Project snapshots support regular files and directories only",
        );
      if (f.isDirectory()) walk(p);
      else
        result[path.relative(dir, p).split(path.sep).join("/")] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex");
    }
  }
  walk(dir);
  return result;
}
const same = (a, b) =>
  JSON.stringify(Object.entries(a || {}).sort()) ===
  JSON.stringify(Object.entries(b || {}).sort());
export function prepare({
  artifacts,
  out,
  acceptance,
  executionVcpu,
  coordinatorVcpu = 4,
}) {
  if (fs.existsSync(out))
    throw Error("Output already exists; choose a fresh --out directory");
  const repo = path.join(artifacts, "repo"),
    sourceHashes = hashes(repo),
    dir = path.join(artifacts, "run/session-events");
  const rows = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .sort((a, b) => a.at - b.at);
  const sessions = [];
  for (const e of rows) {
    if (["run_started", "run_resumed"].includes(e.type))
      sessions.push({
        start: e.at,
        agents: e.agents,
        executionVcpu: e.executionVcpu ?? null,
      });
    if (e.type === "run_finished") sessions.at(-1).end = e.at;
  }
  if (!sessions.length || sessions.some((s) => !s.end))
    throw Error("Only completed trace sessions can be replayed");
  let offset = 0;
  for (const s of sessions) {
    s.duration = s.end - s.start;
    s.offset = offset;
    offset += s.duration;
    s.videoStart =
      2 +
      (26 * s.offset) /
        rows
          .filter((e) => e.type === "run_finished")
          .reduce((n, e, i) => n + (e.at - sessions[i].start), 0);
    s.videoDuration =
      (26 * s.duration) / sessions.reduce((n, x) => n + (x.end - x.start), 0);
    s.label = "Swarm build";
  }
  const active = (t) =>
      sessions.reduce(
        (n, s) => n + Math.max(0, Math.min(t, s.end) - s.start),
        0,
      ),
    req = new Map(),
    events = [],
    groups = new Map(),
    bins = new Map();
  const cpuVerified = Number.isFinite(executionVcpu) && executionVcpu > 0;
  const group = (p) => {
    if (!p) return null;
    const id = p.startsWith("tests/")
      ? "tests"
      : p.startsWith("assets/")
        ? "assets"
        : path.basename(p).replace(/\.[^.]+$/, "");
    if (!groups.has(id) && groups.size < 12)
      groups.set(id, id.replace(/[-_]/g, " "));
    return groups.has(id) ? id : null;
  };
  let nodeTestsPassed = false;
  for (const e of rows) {
    const t = active(e.at),
      agent = e.agent;
    if (e.type === "model_request")
      events.push({ t, kind: "agent", a: agent, s: "thinking" });
    if (e.type === "native_tool_call")
      events.push({
        t,
        kind: "tool",
        a: agent,
        s: ["write_file", "edit_file"].includes(e.toolName)
          ? "writing"
          : ["run_tests", "run_command"].includes(e.toolName)
            ? "testing"
            : "tools",
      });
    if (e.type === "agent_standby")
      events.push({ t, kind: "agent", a: agent, s: "waiting" });
    if (e.type === "run_finished") events.push({ t, kind: "stop" });
    if (e.type === "exec_requested") {
      req.set(e.requestId, e);
      events.push({ t, kind: "inflight", delta: 1 });
    }
    if (["exec_completed", "exec_failed"].includes(e.type)) {
      if (req.has(e.requestId)) events.push({ t, kind: "inflight", delta: -1 });
      const q = req.get(e.requestId),
        p = e.payload || {},
        r = p.result || {},
        g = group(q?.args?.path);
      if (e.type === "exec_failed") continue;
      if (
        ((!p.ok && ["write_file", "edit_file"].includes(e.op)) ||
          (e.op === "acquire_lock" && r.acquired === false)) &&
        g
      )
        events.push({ t, kind: "conflict", g });
      if (p.ok && r.created?.length)
        events.push({
          t,
          kind: "created",
          a: agent,
          ids: r.created.map((x) => x.id),
        });
      if (p.ok && ["write_file", "edit_file"].includes(e.op)) {
        const imports = [
          ...(r.content?.matchAll(
            /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g,
          ) || []),
        ]
          .map((x) => x[1])
          .filter((x) => x.startsWith("."))
          .map((x) =>
            group(
              path.posix.normalize(
                path.posix.join(path.posix.dirname(r.path), x),
              ),
            ),
          )
          .filter((x) => x && x !== g);
        events.push({
          t,
          kind: "write",
          a: agent,
          path: r.path,
          g,
          imports: [...new Set(imports)],
        });
      }
      if (
        e.op === "run_tests" &&
        p.ok &&
        r.exitCode === 0 &&
        r.stableSnapshot &&
        r.testQualityAccepted &&
        same(r.files, sourceHashes)
      ) {
        const tests = Object.keys(sourceHashes)
          .filter((f) => /^tests\/.*\.test\.mjs$/.test(f))
          .sort();
        nodeTestsPassed =
          tests.length > 0 &&
          JSON.stringify(tests) === JSON.stringify([...r.testedFiles].sort());
      }
      const ms = e.timing?.executeMs;
      if (cpuVerified && Number.isFinite(ms)) {
        const end = e.at,
          start = end - ms / 1000;
        for (const s of sessions) {
          const a = Math.max(start, s.start),
            b = Math.min(end, s.end);
          if (b <= a) continue;
          const lo = s.offset + a - s.start,
            hi = s.offset + b - s.start;
          for (let k = Math.floor(lo); k <= Math.floor(hi); k++)
            bins.set(
              k,
              (bins.get(k) || 0) +
                Math.max(0, Math.min(hi, k + 1) - Math.max(lo, k)) *
                  executionVcpu,
            );
        }
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  let curve;
  if (cpuVerified)
    curve = Array.from({ length: Math.ceil(offset) + 1 }, (_, i) => [
      i,
      coordinatorVcpu + (bins.get(i) || 0),
    ]);
  else {
    let n = 0,
      index = 0;
    const inflight = events.filter((e) => e.kind === "inflight");
    curve = Array.from({ length: Math.ceil(offset) + 1 }, (_, i) => {
      while (index < inflight.length && inflight[index].t <= i)
        n += inflight[index++].delta;
      return [i, n];
    });
  }
  const proof = acceptance ? JSON.parse(fs.readFileSync(acceptance)) : null;
  const passed = !!(
    nodeTestsPassed &&
    proof?.stableSnapshot &&
    same(proof.sourceHashes, sourceHashes) &&
    Object.keys(proof.checks || {}).length &&
    Object.values(proof.checks).every((x) => x === true) &&
    Array.isArray(proof.errors) &&
    !proof.errors.length &&
    Array.isArray(proof.warnings) &&
    !proof.warnings.length &&
    !proof.error
  );
  const data = {
    agents: Math.max(...sessions.map((s) => s.agents)),
    nodes: [...groups].map(([id, title]) => ({ id, title })),
    events,
    sessions,
    duration: offset,
    curve,
    cpuPeak: curve.reduce((n, x) => Math.max(n, x[1]), 1),
    cpuVerified,
    nodeTestsPassed,
    acceptance: {
      passed,
      scope:
        "Current full Node suite plus independently supplied browser source hashes/checks",
    },
    entryPoint: sourceHashes["index.html"] ? "index.html" : null,
    assets: Object.keys(sourceHashes)
      .filter((p) => /^assets\/.*\.(png|svg|webp)$/.test(p))
      .slice(0, 4),
    scope:
      "Accelerated retrospective. Allocated vCPU, when explicitly configured, is reconstructed from completed executeMs windows; queue and inference excluded. Raw traces, source and acceptance are not repaired by the renderer.",
  };
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(repo, path.join(out, "game"), { recursive: true });
  fs.copyFileSync(
    path.join(templateRoot, "template.html"),
    path.join(out, "index.html"),
  );
  fs.copyFileSync(
    path.join(templateRoot, "film.js"),
    path.join(out, "film.js"),
  );
  fs.writeFileSync(path.join(out, "data.json"), JSON.stringify(data));
  fs.writeFileSync(
    path.join(out, "source-hashes.json"),
    JSON.stringify(sourceHashes, null, 2),
  );
  return {
    out,
    agents: data.agents,
    events: events.length,
    nodeTestsPassed,
    browserAccepted: passed,
    cpuVerified,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values: v } = parseArgs({
    options: {
      artifacts: { type: "string", default: "artifacts" },
      out: { type: "string", default: "replay" },
      acceptance: { type: "string" },
      "exec-vcpu": { type: "string" },
      "coordinator-vcpu": { type: "string", default: "4" },
    },
  });
  console.log(
    JSON.stringify(
      prepare({
        artifacts: path.resolve(v.artifacts),
        out: path.resolve(v.out),
        acceptance: v.acceptance,
        executionVcpu: v["exec-vcpu"] ? Number(v["exec-vcpu"]) : undefined,
        coordinatorVcpu: Number(v["coordinator-vcpu"]),
      }),
    ),
  );
}
