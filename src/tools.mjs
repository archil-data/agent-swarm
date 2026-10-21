import { Type as T } from "typebox";
const s = () => T.String(),
  n = () => T.Integer(),
  task = T.Object({
    id: s(),
    title: s(),
    description: s(),
    files: T.Array(s()),
    dependencies: T.Optional(T.Array(s())),
  });
export const schemas = {
  read_context: T.Object({}),
  list_tasks: T.Object({}),
  read_task: T.Object({ task_id: s() }),
  list_files: T.Object({}),
  read_messages: T.Object({}),
  read_file: T.Object({ path: s() }),
  create_task: T.Object({ task }),
  create_tasks: T.Object({ tasks: T.Array(task) }),
  claim_task: T.Object({ task_id: s() }),
  abandon_task: T.Object({ task_id: s(), claim_token: n() }),
  complete_task: T.Object({
    task_id: s(),
    claim_token: n(),
    test_call_id: s(),
    summary: s(),
  }),
  update_task: T.Object({
    task_id: s(),
    claim_token: T.Optional(n()),
    expected_version: T.Optional(n()),
    description: T.Optional(s()),
    files: T.Optional(T.Array(s())),
    dependencies: T.Optional(T.Array(s())),
    reopen: T.Optional(T.Boolean()),
  }),
  cancel_task: T.Object({
    task_id: s(),
    claim_token: T.Optional(n()),
    expected_version: T.Optional(n()),
    reason: s(),
  }),
  elect_leader: T.Object({}),
  resign_leader: T.Object({ term: n() }),
  acquire_lock: T.Object({ path: s() }),
  release_lock: T.Object({ path: s(), token: n() }),
  write_file: T.Object({
    path: s(),
    token: n(),
    expected_sha256: T.Union([s(), T.Null()]),
    content: s(),
  }),
  edit_file: T.Object({
    path: s(),
    token: n(),
    expected_sha256: s(),
    old_text: s(),
    new_text: s(),
  }),
  send_message: T.Object({ to: s(), body: s() }),
  run_command: T.Object({ command: s() }),
  run_tests: T.Object({ test_files: T.Array(s()) }),
  wake_peers: T.Object({
    count: T.Integer({ minimum: 1, maximum: 128 }),
    reason: s(),
  }),
  wait_for_work: T.Object({ reason: s() }),
  declare_ready: T.Object({ term: n(), test_call_id: s(), summary: s() }),
};
export const descriptions = {
  read_context:
    "Read the shared brief, task board, files, live leadership and worker capacity. The initial board is empty.",
  list_tasks:
    "Read current agent-created tasks and their versions. Workers choose their own scopes.",
  read_task:
    "Read one task's full description, scope, dependencies and current ownership.",
  list_files: "List project files.",
  read_messages: "Read direct and team filesystem messages.",
  read_file:
    "Read a project file and its current SHA256. A missing file has SHA null.",
  create_task:
    "Every agent can publish useful runnable work without leader approval. Specify concrete artifact paths, including tests. Avoid duplicate scopes.",
  create_tasks:
    "Publish up to 32 useful runnable tasks without leader approval. Agents own decomposition.",
  claim_task:
    "Claim this explicit task atomically. A live peer claim or incomplete dependency prevents acquisition.",
  abandon_task:
    "Return your task to the open board using its current claim token.",
  complete_task:
    "Finish your task with a real passing run_tests receipt covering its declared tests and unchanged artifact hashes.",
  update_task:
    "Revise owned work with claim_token or idle work with a fresh expected_version. Use reopen to restart superseded work.",
  cancel_task:
    "Retire genuinely duplicate work using your claim token or a fresh idle-task version; explain why.",
  elect_leader:
    "Compete for a renewable leadership lease. Leadership coordinates interfaces and acceptance; any agent can create work.",
  resign_leader: "Release your current leadership term.",
  acquire_lock:
    "Acquire a renewable file-edit lease. Holding a task does not grant a file lease. Acquire only when ready to edit.",
  release_lock: "Release your current file-edit token promptly after editing.",
  write_file:
    "Write UTF-8 under a current file token and expected prior SHA. Stale versions are rejected; reread and adapt. BRIEF.md is immutable.",
  edit_file:
    "Replace exactly one occurrence under a current file token and prior SHA. Reread after a mismatch; never force a stale patch.",
  send_message:
    "Write a message to an agent ID or all on the shared filesystem. Negotiate interfaces, edits and integration through this tool.",
  run_command:
    "Run in a FRESH Archil serverless execution with the entire project disk read-only. /tmp does not persist. Use write_file/edit_file for project changes. Code receives no inference keys.",
  run_tests:
    "Run real Node tests. [] discovers tests/**/*.test.mjs. Returns exit status, source hashes, stability and testCallId. A green unit suite alone does not prove browser behavior.",
  wake_peers:
    "Request idle volunteers through a filesystem recruitment record. The harness wakes peers without assigning tasks. Publish useful work and choose count deliberately.",
  wait_for_work:
    "Park when you own no unfinished work and cannot find useful missing work. Create or delegate useful tasks first. No background inference polling.",
  declare_ready:
    "Current leader: finish only after all noncancelled tasks are done and your current full-suite receipt passes unchanged. This certifies Node tests, not browser playability.",
};
