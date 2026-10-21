import crypto from "node:crypto";
export const TASK_SHARDS = 32,
  FILE_SHARDS = 32;
export const bucket = (kind, key) =>
  parseInt(
    crypto.createHash("sha256").update(key).digest("hex").slice(0, 8),
    16,
  ) % (kind === "tasks" ? TASK_SHARDS : FILE_SHARDS);
export const allGuards = (prefix = "coord") => [
  prefix + "/guards/leader",
  ...["tasks", "files"].flatMap((kind) =>
    Array.from(
      { length: 32 },
      (_, i) => `${prefix}/guards/${kind}-${String(i).padStart(2, "0")}`,
    ),
  ),
];
export function guardPaths(op, args, prefix = "coord") {
  const task = (id) =>
      `${prefix}/guards/tasks-${String(bucket("tasks", id)).padStart(2, "0")}`,
    file = (p) =>
      `${prefix}/guards/files-${String(bucket("files", p)).padStart(2, "0")}`;
  let items = [];
  if (["elect_leader", "resign_leader"].includes(op))
    items = [prefix + "/guards/leader"];
  else if (["create_task", "propose_task"].includes(op))
    items = [task(args.task.id)];
  else if (["create_tasks", "split_task"].includes(op))
    items = [
      ...args.tasks.map((t) => task(t.id)),
      ...(op === "split_task" ? [task(args.task_id)] : []),
    ];
  else if (
    [
      "claim_task",
      "abandon_task",
      "update_task",
      "cancel_task",
      "complete_task",
      "finalize_split",
    ].includes(op)
  )
    items = [task(args.task_id)];
  else if (
    [
      "acquire_lock",
      "release_lock",
      "write_file",
      "edit_file",
      "publish_image",
    ].includes(op)
  )
    items = [file(args.path)];
  else if (op === "renew_leases")
    items = [
      ...(args.task_ids || []).map(task),
      ...(args.paths || []).map(file),
      ...(args.leader ? [prefix + "/guards/leader"] : []),
    ];
  else if (op === "declare_ready") items = allGuards(prefix);
  return [...new Set(items)].sort();
}
