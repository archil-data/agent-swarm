import { Archil } from "disk";
import crypto from "node:crypto";
import { guardPaths, bucket } from "./scope.mjs";

export const mutations = new Set([
  "elect_leader",
  "resign_leader",
  "create_task",
  "create_tasks",
  "propose_task",
  "finalize_split",
  "update_task",
  "cancel_task",
  "claim_task",
  "abandon_task",
  "acquire_lock",
  "release_lock",
  "write_file",
  "edit_file",
  "send_message",
  "complete_task",
  "renew_leases",
  "declare_ready",
]);
export class Protocol {
  constructor(config, log = () => {}) {
    this.config = config;
    this.api = new Archil({ region: config.region });
    this.log = log;
    this.tasks = new Map();
    this.locks = new Map();
    this.leader = null;
    this.leaderObservedAt = 0;
  }
  async disk() {
    return this.api.disks.get(this.config.diskId);
  }
  async call(
    agent,
    op,
    args = {},
    callId = crypto.randomUUID(),
    origin = "model",
  ) {
    const requestId = crypto
      .createHash("sha256")
      .update(agent + ":" + callId)
      .digest("hex")
      .slice(0, 40);
    const paths = guardPaths(op, args),
      mut = mutations.has(op);
    const mount = mut
      ? {
          disk: this.config.diskId,
          conditional: true,
          ...(paths.length ? { checkoutPaths: paths, queueMs: 60000 } : {}),
        }
      : { disk: this.config.diskId, readOnly: true };
    const request = { agent, op, args, call: requestId, guardPaths: paths };
    const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
    const command = `SWARM_LEADER_SECONDS=180 python3 /mnt/archil/workspace/runtime/fs_tools.py '${encoded}'`;
    const began = Date.now();
    this.log("exec_requested", { agent, op, args, origin, requestId });
    try {
      const result = await this.api.exec({
        disks: { workspace: mount },
        command,
      });
      const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
      this.log("exec_completed", {
        agent,
        op,
        origin,
        requestId,
        timing: result.timing,
        endToEndMs: Date.now() - began,
        payload,
      });
      if (payload.ok) {
        const r = payload.result;
        // Parallel calls can finish out of order; retain the newest observation.
        if ((payload.serverTime || 0) >= this.leaderObservedAt) {
          this.leader = payload.leader;
          this.leaderObservedAt = payload.serverTime || 0;
        }
        for (const t of [
          ...(r.created || []),
          ...(r.tasks || []),
          ...(r.task ? [r.task] : []),
        ])
          if ((t.version || 0) >= (this.tasks.get(t.id)?.version || 0))
            this.tasks.set(t.id, t);
        if (op === "acquire_lock" && r.acquired)
          this.locks.set(args.path, r.lock);
        if (op === "release_lock") this.locks.delete(args.path);
        if (["run_tests", "run_command"].includes(op))
          await (
            await this.disk()
          ).putObject(
            "coord/test-receipts/" + requestId + ".json",
            JSON.stringify(r),
          );
      }
      return payload;
    } catch (error) {
      this.log("exec_failed", {
        agent,
        op,
        origin,
        requestId,
        error: String(error),
      });
      return { ok: false, error: String(error) };
    }
  }
  async renew(owners) {
    const groups = new Map();
    const group = (key) => {
      if (!groups.has(key))
        groups.set(key, { owners, task_ids: [], paths: [] });
      return groups.get(key);
    };
    for (const t of this.tasks.values())
      if (t.status === "working" && owners.includes(t.owner))
        group("tasks-" + bucket("tasks", t.id)).task_ids.push(t.id);
    for (const [path, l] of this.locks)
      if (owners.includes(l.owner))
        group("files-" + bucket("files", path)).paths.push(path);
    return Promise.all(
      [...groups.values()].map((args) =>
        this.call(
          "harness-renewal",
          "renew_leases",
          args,
          undefined,
          "heartbeat",
        ),
      ),
    );
  }
}
