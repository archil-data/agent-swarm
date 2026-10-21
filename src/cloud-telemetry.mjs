import fs from "node:fs";
// Local journaling keeps filesystem flush latency off the model/liveness event loop.
export function telemetry(
  disk,
  dir,
  sessionId,
  { intervalMs = 6000, onError = () => {} } = {},
) {
  let busy = false,
    closed = false;
  const pending = new Set(),
    channels = new Map();
  function coalesce(key, data) {
    let channel = channels.get(key);
    if (!channel) {
      channel = { next: undefined, promise: null };
      channels.set(key, channel);
    }
    channel.next = data;
    if (!channel.promise) {
      channel.promise = (async () => {
        while (channel.next !== undefined) {
          const next = channel.next;
          channel.next = undefined;
          try {
            await upload(key, next);
          } catch (e) {
            onError(key, e);
          }
        }
      })().finally(() => {
        pending.delete(channel.promise);
        channel.promise = null;
      });
      pending.add(channel.promise);
    }
    return channel.promise;
  }
  async function upload(key, data) {
    for (let i = 0; i < 3; i++) {
      try {
        return await disk.putObject(key, data);
      } catch (error) {
        if (i === 2) throw error;
        await new Promise((r) => setTimeout(r, 500 * 3 ** i));
      }
    }
  }
  async function progress() {
    if (busy || closed) return;
    busy = true;
    try {
      if (fs.existsSync(dir + "/stats.json"))
        await upload("run/stats.json", fs.readFileSync(dir + "/stats.json"));
    } catch (e) {
      onError("stats", e);
    } finally {
      busy = false;
    }
  }
  function context(id) {
    return coalesce(
      "run/contexts/" + id + ".json",
      fs.readFileSync(dir + "/contexts/" + id + ".json"),
    );
  }
  function capacity(value) {
    return coalesce("coord/capacity.json", JSON.stringify(value));
  }
  const timer = setInterval(() => void progress(), intervalMs);
  timer.unref();
  return {
    progress,
    context,
    capacity,
    async finish(result) {
      closed = true;
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 100));
      await Promise.allSettled([...pending]);
      await upload("run/stats.json", fs.readFileSync(dir + "/stats.json"));
      await upload(
        "run/session-events/" + sessionId + ".jsonl",
        fs.readFileSync(dir + "/events.jsonl"),
      );
      await upload("run/result.json", JSON.stringify(result));
    },
  };
}
export function taskView(t) {
  if (["done", "cancelled"].includes(t.status))
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      files: t.files,
      version: t.version,
    };
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    files: t.files,
    dependencies: t.dependencies || [],
    owner: t.owner,
    claimToken: t.claimToken,
    expiresAt: t.expiresAt,
    version: t.version,
    createdBy: t.createdBy,
    ...(!["done", "cancelled"].includes(t.status)
      ? { description: t.description?.slice(0, 240) }
      : {}),
  };
}
export function modelView(op, value) {
  const copy = structuredClone(value);
  if (["read_context", "list_tasks"].includes(op) && copy.result?.tasks) {
    copy.result.taskCount = copy.result.tasks.length;
    copy.result.tasks = copy.result.tasks.map(taskView);
    copy.result.taskDetails =
      "Use read_task for full scope or claim_task to receive full claimed task. Done records are point-in-time; later changes can invalidate their tests.";
  }
  if (["write_file", "edit_file"].includes(op) && copy.result)
    delete copy.result.content;
  return copy;
}
