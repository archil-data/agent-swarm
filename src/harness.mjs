import fs from "node:fs";
import crypto from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { Protocol } from "./protocol.mjs";
import { schemas, descriptions } from "./tools.mjs";
import { prompt } from "./prompt.mjs";
import { compactHistory } from "./compact-history.mjs";
import { telemetry, modelView } from "./cloud-telemetry.mjs";

export async function runHarness(
  config,
  {
    AgentClass = Agent,
    models = createModels(),
    protocolFactory = (config, log) => new Protocol(config, log),
    telemetryFactory = telemetry,
    pollMs = 5000,
  } = {},
) {
  const dir = process.env.SWARM_JOURNAL || "/tmp/archil-swarm-journal";
  fs.mkdirSync(dir + "/contexts", { recursive: true });
  const log = (type, row = {}) =>
    fs.appendFileSync(
      dir + "/events.jsonl",
      JSON.stringify({ type, at: Date.now() / 1000, ...row }) + "\n",
    );
  const remote = protocolFactory(config, log),
    disk = await remote.disk(),
    actors = [],
    requestsSeen = new Set();
  const stats = {
    started: Date.now() / 1000,
    modelRequests: 0,
    nativeToolCalls: 0,
    estimatedInferenceCost: 0,
  };
  const journal = telemetryFactory(disk, dir, "session-" + Date.now(), {
    onError: (key, e) => log("telemetry_error", { key, error: String(e) }),
  });
  models.setProvider(openrouterProvider());
  const model = models.getModel("openrouter", config.model);
  if (!model)
    throw Error("Model absent from the pinned Pi catalog: " + config.model);
  let stop = "",
    ready = null,
    leaseBusy = false,
    leaderBusy = false;
  const halt = (reason) => {
    if (!stop) {
      stop = reason;
      log("stop_requested", { reason });
      for (const a of actors) a.agent.abort();
    }
  };
  const save = () =>
    fs.writeFileSync(
      dir + "/stats.json",
      JSON.stringify({
        ...stats,
        stop,
        agents: actors.map((a) => ({
          id: a.id,
          active: a.active,
          turns: a.turns,
          parked: a.parked,
          error: a.error,
        })),
      }),
    );
  const capacity = () =>
    journal.capacity({
      at: Date.now() / 1000,
      totalContexts: config.agents,
      activeContexts: actors.filter((a) => a.active).length,
      idleContexts: actors.filter((a) => !a.active).length,
      inferenceSpentUsd: stats.estimatedInferenceCost,
      inferenceBudgetUsd: config.budgetUsd,
    });
  function actor(id) {
    const a = { id, active: false, parked: false, turns: 0, error: null };
    a.agent = new AgentClass({
      initialState: {
        systemPrompt: prompt(config.agents),
        model,
        thinkingLevel: "off",
      },
      toolExecution: "parallel",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
      streamFn: (m, context, options) => {
        if (stop) throw Error(stop);
        if (
          stats.modelRequests >= config.maxModelRequests ||
          stats.estimatedInferenceCost >= config.budgetUsd
        ) {
          halt("inference_limit");
          throw Error(stop);
        }
        stats.modelRequests++;
        save();
        log("model_request", { agent: id, model: config.model });
        return models.streamSimple(
          m,
          { ...context, messages: compactHistory(context.messages).messages },
          {
            ...options,
            maxTokens: config.maxOutputTokens,
            timeoutMs: 90000,
            maxRetries: 0,
          },
        );
      },
    });
    a.agent.state.tools = Object.entries(schemas).map(([name, parameters]) => ({
      name,
      label: name,
      description: descriptions[name],
      parameters,
      execute: async (callId, args) => {
        if (stop) throw Error(stop);
        let result;
        if (name === "wake_peers") {
          const request = {
            id: crypto.randomUUID(),
            agent: id,
            at: Date.now() / 1000,
            count: args.count,
            reason: args.reason,
          };
          await disk.putObject(
            "coord/recruitment/" + request.id + ".json",
            JSON.stringify(request),
          );
          result = { ok: true, result: { request } };
        } else if (name === "wait_for_work") {
          const owns = [...remote.tasks.values()].some(
            (t) =>
              t.owner === id &&
              t.status === "working" &&
              t.expiresAt > Date.now() / 1000,
          );
          if (
            owns ||
            (remote.leader?.owner === id &&
              remote.leader.expiresAt > Date.now() / 1000)
          )
            result = {
              ok: false,
              error:
                "Finish or abandon owned tasks and resign live leadership before parking",
            };
          else {
            a.parked = true;
            result = { ok: true, result: { parked: true }, terminate: true };
          }
        } else result = await remote.call(id, name, args, callId);
        return {
          content: [
            { type: "text", text: JSON.stringify(modelView(name, result)) },
          ],
          isError: !result.ok,
          ...(result.terminate ? { terminate: true } : {}),
        };
      },
    }));
    a.agent.subscribe((e) => {
      if (e.type === "turn_start" && ++a.turns > config.maxTurnsPerAgent) {
        a.error = "turn_limit";
        a.agent.abort();
      }
      if (e.type === "message_end" && e.message.role === "assistant") {
        stats.estimatedInferenceCost += e.message.usage?.cost?.total || 0;
        log("assistant_message", { agent: id, message: e.message });
        if (e.message.stopReason === "error") {
          a.error = e.message.errorMessage || "provider_error";
          halt("provider_error");
        }
        if (stats.estimatedInferenceCost >= config.budgetUsd)
          halt("inference_limit");
      }
      if (e.type === "tool_execution_start") {
        stats.nativeToolCalls++;
        log("native_tool_call", {
          agent: id,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        });
      }
      if (e.type === "tool_execution_end")
        log("native_tool_result", {
          agent: id,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          isError: e.isError,
          result: e.result,
        });
      save();
    });
    return a;
  }
  async function launch(a, text) {
    if (a.active || stop || a.turns >= config.maxTurnsPerAgent) return;
    a.active = true;
    a.parked = false;
    log("agent_started", { agent: a.id });
    capacity();
    try {
      await a.agent.prompt(text);
    } catch (e) {
      a.error = String(e);
      log("agent_error", { agent: a.id, error: a.error });
    } finally {
      a.active = false;
      fs.writeFileSync(
        dir + "/contexts/" + a.id + ".json",
        JSON.stringify(a.agent.state.messages),
      );
      await journal.context(a.id);
      log("agent_standby", { agent: a.id });
      save();
      capacity();
    }
  }
  for (let i = 1; i <= config.agents; i++)
    actors.push(actor("agent-" + String(i).padStart(3, "0")));
  const renew = setInterval(async () => {
    if (leaseBusy || stop) return;
    leaseBusy = true;
    try {
      await remote.renew(actors.filter((a) => a.active).map((a) => a.id));
    } finally {
      leaseBusy = false;
    }
  }, 18000);
  const leadership = setInterval(async () => {
    if (
      leaderBusy ||
      stop ||
      !remote.leader ||
      !actors.some((a) => a.id === remote.leader.owner && a.active)
    )
      return;
    leaderBusy = true;
    try {
      await remote.call(
        "harness-leader",
        "renew_leases",
        { owners: [remote.leader.owner], leader: true },
        undefined,
        "heartbeat",
      );
    } finally {
      leaderBusy = false;
    }
  }, 10000);
  const deadline = setTimeout(() => halt("deadline"), config.minutes * 60000);
  const sigterm = () => halt("signal");
  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigterm);
  let result;
  try {
    log("run_started", {
      agents: config.agents,
      model: config.model,
      initialProjectFiles: ["BRIEF.md"],
      taskSource: "agent-created",
      harnessLocation: "archil-sandbox",
      coordinatorVcpu: 4,
      executionVcpu: config.executionVcpu ?? null,
    });
    for (const a of actors.slice(0, config.initialWorkers))
      void launch(
        a,
        `Your ID is ${a.id}. There are ${config.agents} peers. Read the shared brief and organize yourselves; every agent can create tasks and recruit peers.`,
      );
    while (!stop) {
      await new Promise((r) => setTimeout(r, pollMs));
      save();
      capacity();
      const board = await remote.call(
        "harness-observer",
        "list_tasks",
        {},
        undefined,
        "observer",
      );
      if (board.result?.ready) {
        ready = board.result.ready;
        halt("agents_declared_ready");
        break;
      }
      for (const { key } of (
        await disk.listObjects("coord/recruitment/", { recursive: true })
      ).objects) {
        if (!key.endsWith(".json") || requestsSeen.has(key)) continue;
        const req = JSON.parse(Buffer.from(await disk.getObject(key)));
        requestsSeen.add(key);
        const volunteers = actors
          .filter(
            (a) =>
              !a.active &&
              a.id !== req.agent &&
              a.turns < config.maxTurnsPerAgent,
          )
          .slice(0, req.count);
        await disk.putObject(
          "coord/recruitment-receipts/" + req.id + ".json",
          JSON.stringify({
            request: req.id,
            volunteers: volunteers.map((a) => a.id),
          }),
        );
        for (const a of volunteers)
          void launch(
            a,
            `Peer ${req.agent} requested volunteers: ${req.reason}. Inspect current shared state and choose useful work; no task is assigned to you.`,
          );
      }
      if (!actors.some((a) => a.active)) {
        halt("all_agents_idle_without_verified_readiness");
        break;
      }
    }
  } finally {
    clearInterval(renew);
    clearInterval(leadership);
    clearTimeout(deadline);
    for (const a of actors) a.agent.abort();
    while (actors.some((a) => a.active) || leaseBusy || leaderBusy)
      await new Promise((r) => setTimeout(r, 100));
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigterm);
    result = {
      ...stats,
      finished: Date.now() / 1000,
      success: !!ready,
      stopReason: stop,
      ready,
      scope:
        "Agent-created tasks and source. Readiness proves current Node tests only; independently check browser behavior.",
    };
    log("run_finished", result);
    save();
    await journal.finish(result);
  }
  return result;
}
