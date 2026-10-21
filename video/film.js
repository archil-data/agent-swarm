const data = await fetch("data.json").then((r) => r.json()),
  $ = (s) => document.querySelector(s),
  nodeMap = new Map(),
  agentMap = new Map(),
  positions = new Map();
let states,
  writers,
  tasks,
  paths,
  imports,
  idx,
  cost,
  tools,
  inflight,
  groups,
  lastTime = -1;
$("#agentHeading").textContent = data.agents + " agents.";
$("#contextCount").textContent = data.agents;
$("#computeLabel").textContent = data.cpuVerified
  ? "Concurrent vCPU"
  : "Tool executions";
$("#computeScope").textContent = data.cpuVerified
  ? "Estimated allocation · queue excluded"
  : "Recorded in-flight executions";
document.querySelector("#game").src = data.entryPoint
  ? "game/" + data.entryPoint
  : "about:blank";
const agentColumns = Math.min(16, Math.ceil(Math.sqrt(data.agents * 2)));
$("#agents").style.gridTemplateColumns = "repeat(" + agentColumns + ",1fr)";
for (let i = 1; i <= data.agents; i++) {
  const el = document.createElement("i");
  el.style.height =
    Math.max(
      12,
      Math.min(36, Math.floor(128 / Math.ceil(data.agents / agentColumns)) - 4),
    ) + "px";
  $("#agents").append(el);
  agentMap.set("agent-" + String(i).padStart(3, "0"), el);
}
for (const [i, n] of data.nodes.entries()) {
  const col = i % 3,
    row = Math.floor(i / 3),
    x = 8 + col * 201,
    y = 12 + row * 103;
  positions.set(n.id, { x: x + 87, y: y + 39 });
  const el = document.createElement("div");
  el.className = "node";
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.innerHTML = "<strong></strong><small>Awaiting file writes</small>";
  el.querySelector("strong").textContent = n.title;
  $("#nodes").append(el);
  nodeMap.set(n.id, el);
}
for (const p of data.assets) {
  const box = document.createElement("div"),
    img = document.createElement("img");
  img.src = "game/" + p;
  img.alt = p;
  box.append(img);
  $("#art").append(box);
  img.dataset.path = p;
}
function reset() {
  states = new Map();
  writers = new Set();
  tasks = new Set();
  paths = new Set();
  imports = new Map();
  groups = new Map(
    data.nodes.map((n) => [
      n.id,
      {
        paths: new Set(),
        authors: new Set(),
        lastWrite: -99,
        lastConflict: -99,
      },
    ]),
  );
  idx = 0;
  cost = 0;
  tools = 0;
  inflight = 0;
}
function recordedTime(t) {
  if (t < 2) return 0;
  for (const s of data.sessions)
    if (t < s.videoStart + s.videoDuration)
      return (
        s.offset +
        (Math.max(0, t - s.videoStart) / s.videoDuration) * s.duration
      );
  return data.duration;
}
function filmTime(t) {
  for (const s of data.sessions)
    if (t <= s.offset + s.duration + 0.001)
      return s.videoStart + ((t - s.offset) / s.duration) * s.videoDuration;
  return 28;
}
function apply(t) {
  while (idx < data.events.length && data.events[idx].t <= t + 0.0001) {
    const e = data.events[idx++];
    if (e.kind === "agent") states.set(e.a, e.s);
    else if (e.kind === "tool") {
      tools++;
      states.set(e.a, e.s);
    } else if (e.kind === "cost") cost += e.value;
    else if (e.kind === "created") for (const id of e.ids) tasks.add(id);
    else if (e.kind === "inflight") inflight += e.delta;
    else if (e.kind === "stop")
      for (const a of agentMap.keys()) states.set(a, "waiting");
    else if (e.kind === "conflict") {
      groups.get(e.g).lastConflict = filmTime(e.t);
    } else if (e.kind === "write") {
      writers.add(e.a);
      paths.add(e.path);
      if (e.g) {
        const g = groups.get(e.g);
        g.paths.add(e.path);
        g.authors.add(e.a);
        g.lastWrite = filmTime(e.t);
        imports.set(e.path, { from: e.g, to: e.imports });
      }
    }
  }
}
function drawGraph(videoTime) {
  for (const [id, el] of nodeMap) {
    const g = groups.get(id);
    el.className =
      "node" +
      (g.paths.size ? " written" : "") +
      (videoTime - g.lastConflict < 0.65 ? " conflict" : "");
    el.querySelector("small").textContent = g.paths.size
      ? `${g.paths.size} files · ${g.authors.size} agents`
      : "Awaiting file writes";
    const strength = Math.max(0, 1 - (videoTime - g.lastWrite) / 0.4);
    el.style.boxShadow = g.paths.size
      ? `0 0 ${Math.round(strength * 19)}px #b3dd8c${Math.round(strength * 55)
          .toString(16)
          .padStart(2, "0")}`
      : "none";
  }
  const edges = new Set();
  for (const v of imports.values())
    for (const to of v.to)
      if (groups.get(to)?.paths.size) edges.add(v.from + "|" + to);
  let html = "";
  for (const edge of edges) {
    const [from, to] = edge.split("|"),
      a = positions.get(from),
      b = positions.get(to);
    if (!a || !b) continue;
    const diffX = b.x - a.x,
      diffY = b.y - a.y,
      x1 =
        a.x + (Math.abs(diffX) > Math.abs(diffY) ? Math.sign(diffX) * 88 : 0),
      y1 =
        a.y + (Math.abs(diffY) >= Math.abs(diffX) ? Math.sign(diffY) * 40 : 0),
      x2 =
        b.x - (Math.abs(diffX) > Math.abs(diffY) ? Math.sign(diffX) * 88 : 0),
      y2 =
        b.y - (Math.abs(diffY) >= Math.abs(diffX) ? Math.sign(diffY) * 40 : 0);
    html += `<path d="M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}"/>`;
  }
  $("#edges").innerHTML = html;
}
function chart(t) {
  const w = 284,
    h = 76,
    max = data.cpuPeak;
  const past = [];
  let bucket = -1,
    lo,
    hi,
    last;
  for (const p of data.curve) {
    if (p[0] > t) break;
    const b = Math.floor((p[0] / data.duration) * w);
    if (b !== bucket) {
      if (last) {
        for (const q of [lo, hi].sort((a, b) => a[0] - b[0])) past.push(q);
        past.push(last);
      }
      bucket = b;
      lo = hi = p;
    } else {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
    }
    last = p;
  }
  if (last) {
    for (const q of [lo, hi].sort((a, b) => a[0] - b[0])) past.push(q);
    past.push(last);
  }
  if (!past.length) {
    $("#chart").innerHTML = "";
    return;
  }
  let points = "M0 78";
  for (const [at, n] of past)
    points += ` L${((at / data.duration) * w).toFixed(1)} ${(78 - (n / max) * h).toFixed(1)}`;
  points += ` L${((t / data.duration) * w).toFixed(1)} ${(78 - (currentCpu(t) / max) * h).toFixed(1)}`;
  $("#chart").innerHTML =
    `<path d="${points} L${(t / data.duration) * w} 80 Z" fill="#86b178" opacity=".13"/><path d="${points}" fill="none" stroke="#a5c690" stroke-width="1.8"/><line x1="0" y1="80" x2="284" y2="80" stroke="#344c39"/>`;
}
function currentCpu(t) {
  return data.curve[Math.min(data.curve.length - 1, Math.floor(t))]?.[1] || 0;
}
function seek(videoTime) {
  videoTime = Math.max(0, Math.min(36, videoTime));
  const t = recordedTime(videoTime);
  if (t < lastTime || !states) reset();
  apply(t);
  lastTime = t;
  document.body.classList.toggle("ending", videoTime >= 28);
  const phase = data.sessions.find(
    (s) => videoTime < s.videoStart + s.videoDuration,
  );
  const stage =
    videoTime < 2
      ? "One shared brief."
      : videoTime >= 28
        ? data.acceptance?.passed
          ? "Their application. Verified."
          : "Their application. Check acceptance."
        : phase?.label === "Swarm build"
          ? "Agents create and build the work."
          : (phase?.videoStart >= 17 && phase?.videoDuration < 1
              ? "Integration + QA"
              : phase?.label) || "Integration";
  $("#phase").textContent = stage;
  $("#clock").innerHTML =
    `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}<small>active time</small>`;
  for (const [id, el] of agentMap) {
    el.dataset.state = states.get(id) || "waiting";
    el.classList.toggle("contributed", writers.has(id));
  }
  drawGraph(videoTime);
  chart(t);
  $("#inflight").textContent = Math.round(currentCpu(t)).toLocaleString();
  $("#taskCount").textContent = tasks.size.toLocaleString();
  $("#writers").textContent = writers.size;
  $("#toolCount").textContent = tools.toLocaleString();
  for (const img of document.querySelectorAll("#art img"))
    img.style.opacity = paths.has(img.dataset.path) ? "1" : "0";
  return {
    videoTime,
    recordedTime: t,
    tasks: tasks.size,
    writers: writers.size,
    tools,
    cost,
    inflight,
  };
}
if (data.acceptance?.passed) {
  document.body.classList.add("verified");
  $("#result .resulthead strong").textContent =
    "Built by the agents. Verified.";
  $("#result .resulthead span").textContent = "Gameplay verified";
  $("#result .failure").textContent = "Independent browser checks passed";
}
if (!data.acceptance?.passed) {
  $("#result .resulthead strong").textContent = data.nodeTestsPassed
    ? "Full Node suite passed."
    : "Acceptance incomplete.";
  $("#result .resulthead span").textContent = "Browser check required";
}
reset();
seek(0);
await Promise.all(
  [...document.images].map((img) => img.decode().catch(() => {})),
);
window.swarmFilm = { ready: true, seek, data, duration: 36 };
