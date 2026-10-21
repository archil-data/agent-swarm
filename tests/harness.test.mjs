import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runHarness } from "../src/harness.mjs";
test("the real Pi loop dispatches independent tools concurrently and an idle team is not declared successful", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-harness-")),
    prior = process.env.SWARM_JOURNAL;
  process.env.SWARM_JOURNAL = dir;
  let calls = 0,
    inflight = 0,
    peak = 0;
  const messages = [];
  const model = {
    id: "fixture",
    provider: "openrouter",
    api: "openai-completions",
    name: "Fixture",
    input: ["text"],
    reasoning: false,
    contextWindow: 100000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const models = {
    setProvider() {},
    getModel() {
      return model;
    },
    streamSimple() {
      const stream = createAssistantMessageEventStream(),
        first = ++calls === 1;
      const message = {
        role: "assistant",
        content: first
          ? [
              {
                type: "toolCall",
                id: "one",
                name: "send_message",
                arguments: { to: "all", body: "first" },
              },
              {
                type: "toolCall",
                id: "two",
                name: "send_message",
                arguments: { to: "all", body: "second" },
              },
            ]
          : [
              {
                type: "text",
                text: "Fixture ended without declaring readiness.",
              },
            ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  };
  const disk = {
    putObject: async () => {},
    listObjects: async () => ({ objects: [] }),
  };
  const protocol = {
    tasks: new Map(),
    locks: new Map(),
    leader: null,
    disk: async () => disk,
    renew: async () => {},
    call: async (id, op, args) => {
      if (op === "send_message") {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 15));
        messages.push(args.body);
        inflight--;
        return { ok: true, result: { sent: true } };
      }
      return { ok: true, result: { tasks: [] } };
    },
  };
  try {
    const result = await runHarness(
      {
        agents: 1,
        initialWorkers: 1,
        minutes: 0.05,
        budgetUsd: 1,
        maxModelRequests: 5,
        maxOutputTokens: 1000,
        maxTurnsPerAgent: 10,
        model: "fixture",
      },
      {
        models,
        protocolFactory: () => protocol,
        telemetryFactory: () => ({
          capacity() {},
          context: async () => {},
          finish: async () => {},
        }),
        pollMs: 5,
      },
    );
    assert.equal(result.success, false);
    assert.equal(
      result.stopReason,
      "all_agents_idle_without_verified_readiness",
    );
    assert.equal(result.modelRequests, 2);
    assert.equal(result.nativeToolCalls, 2);
    assert.equal(peak, 2);
    assert.deepEqual(messages.sort(), ["first", "second"]);
    assert(fs.existsSync(dir + "/contexts/agent-001.json"));
  } finally {
    if (prior === undefined) delete process.env.SWARM_JOURNAL;
    else process.env.SWARM_JOURNAL = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
