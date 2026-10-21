# Agent swarm on one Archil filesystem

A reference custom harness built around [Pi's agent core](https://github.com/earendil-works/pi/tree/main/packages/agent). Several model contexts collaborate on one project, using an Archil filesystem for tasks, file leases, leadership, messages and recruitment. Their commands execute in fresh Archil serverless microVMs. All Pi contexts run together in one 4-vCPU Archil coordinator sandbox.

This is an extracted, smaller teaching implementation of the factory-game experiment. It is not the exact historical runner or a claim that the original game emerged in one unattended pass. The original experiment required multiple integration passes, host QA feedback and harness repairs. No private run logs, credentials, internal SDK, original game assets or company infrastructure configuration are included here.

## Runtime and recorded experiment

Each worker is a separate Pi `Agent` instance with its own conversation. All worker loops run asynchronously in one Node.js process inside a **4-vCPU, 4-GiB Archil coordinator sandbox**. Model inference runs through OpenRouter; filesystem tools, shell commands and tests run in fresh Archil serverless executions. Independent tools are dispatched concurrently. The shared filesystem holds the task board, messages, leadership and file leases, rather than a separate coordination database or message broker.

The original factory-game experiment used this architecture and produced the following recorded results. These describe the historical run, **not a new benchmark of the smaller example in this repository**:

| Metric | Recorded value |
| --- | --- |
| Available agent contexts | 128 |
| Recorded phase duration | 81 min 22 sec, summed across 13 phases |
| Model-selected tool calls | 10,621 |
| Agents that created tasks | 75 |
| Agents with accepted artifact writes | 87 |
| Final independent validation | 565 Node tests and 10 browser checks passed |

The duration includes recorded setup, retries and repair phases; it excludes gaps between phases and is not end-to-end elapsed time. Host QA feedback and harness repairs were part of the experiment. The final artifact passed independent checks, but the run was checkpointed with legacy unfinished task records still present; the agents did not formally declare the whole board complete. Accepted writes show participation, not net useful work.

| Tool-call purpose | Calls | Share |
| --- | ---: | ---: |
| Reading files and shared state | 4,343 | 40.9% |
| Task coordination and team management | 2,754 | 25.9% |
| File lease acquisition and release | 992 | 9.3% |
| Commands and tests | 1,379 | 13.0% |
| Source writes and edits | 464 | 4.4% |
| Browser checks | 338 | 3.2% |
| Image and asset tools | 351 | 3.3% |
| **Total** | **10,621** | **100%** |

[Per-tool counts](benchmarks/factory-swarm-128/tool-calls.csv) and [aggregate results and counting methodology](benchmarks/factory-swarm-128/summary.json) are included without private transcripts. Counts include failed, rejected and repeated attempts. They exclude the harness's 3,552 lease-renewal, 940 observation and 13 validation execution requests, as well as external host QA and probes. One tool call can produce zero, one or several serverless executions. Historical browser and image tools are not included in the smaller reference harness below.

## Why these tools, and how writes stay coordinated

The [25 reference tools](src/tools.mjs) give agents the operations needed to organize and verify their own work:

- **Inspect before acting:** context, task, message and file reads make shared work and current file versions visible.
- **Let any peer organize work:** create, claim, update, abandon and cancel tasks; send messages; recruit volunteers; park idle contexts. Leadership coordinates interfaces and final acceptance rather than assigning every task.
- **Make edits explicit:** file leases and expected-version writes separate ownership from assumptions about source contents.
- **Execute and verify:** shell commands and tests run outside the coordinator, and task completion requires test evidence. `declare_ready` checks the current full Node suite; browser playability needs independent acceptance.

A file edit follows `read_file → acquire_lock → write_file/edit_file → release_lock`. Short native checkouts on permanent guard files serialize the ownership check and mutation for a task or file shard. The renewable file lease has an ownership token; the write must also supply the SHA-256 of the version the agent read. Expired ownership is rejected, and a stale SHA requires rereading and adapting the edit. The model's shell execution mounts the shared disk read-only, so ordinary commands cannot bypass the edit protocol.

For example, if Bob updates a module after Alice reads it, Alice's later write is rejected even if she obtains the lease. She must reread Bob's version and integrate her change, or negotiate with Bob through filesystem messages. This prevents stale overwrites among cooperating writers; it does not merge source code or resolve incompatible APIs. Tests use a private source snapshot and compare full project hashes so concurrent changes cannot silently become passing evidence for untested code.

## Try the coordination protocol without inference

Node 22.19+ and Python 3 are required locally for development tests. Install the public pinned dependencies:

```sh
npm ci
npm test
export ARCHIL_API_KEY=...
export ARCHIL_REGION=aws-us-west-2
npm run conflict -- --out artifacts-conflict
```

The conflict command creates a fresh isolated disk and uses real serverless executions. Alice owns a file; Bob's lease request is rejected. Bob later edits it; Alice's old ownership token and stale file version are both rejected. Alice rereads and appends to Bob's current content. It checks that both contributions survive. This is a **scripted protocol test**, explicitly labelled separately from model-driven activity. It incurs Archil calls but makes no model requests.

The disk ID is saved in `artifacts-conflict/disk.json`; the disk is retained for inspection. To delete it deliberately:

```javascript
import * as archil from "disk";
await (await archil.getDisk(diskId)).delete();
```

## Run the swarm

```sh
export OPENROUTER_API_KEY=...
npm start -- --agents 4 --minutes 5 --budget 5 --out artifacts
```

Each agent receives only the same `examples/dashboard/BRIEF.md` and an empty shared task board. The team designs its own factory dashboard, modules, tests, original SVG/canvas art and task decomposition. Every agent may publish tasks or request volunteers. There are no host-assigned implementation roles or prebuilt application files.

The command bundles the harness, uploads its runtime and brief, runs the model loops **inside an Archil sandbox**, and deletes that coordinator on normal completion or a handled error. SIGINT/SIGTERM attempt cleanup and export within 30 seconds; a forced termination or network failure can still require manual recovery, with the coordinator's hard TTL as a backstop. Disk and coordinator IDs are saved locally. Failed preparation attempts to delete its new disk. It exports the source, contexts, receipts and raw trace locally, retaining a successfully prepared shared disk. Each command requires a fresh output directory. Inspect `artifacts/run/result.json`: a deadline, provider failure or idle team is reported as incomplete, never silently labelled success.

Options:

- `--agents 1..128`: available contexts, default 4.
- `--initial N`: contexts to start immediately, default all available. Other contexts wake only after peer-created filesystem recruitment requests.
- `--brief ./BRIEF.md`: a different broad task.
- `--model <OpenRouter model id>`: a model present in the pinned Pi catalog; default `anthropic/claude-sonnet-5.5`.
- `--minutes N`, `--max-requests N`: run deadline and model-request limit.
- `--budget N`: **soft** USD threshold based on returned provider usage. Concurrent in-flight requests can exceed it; interrupted responses may lack usage. Use a provider-side key limit for a strict spending limit. This is not a budget for Archil or storage.

Tool dispatch is uncapped; independent tools in a model response execute concurrently. `--agents` controls available model contexts, not an execution-slot pool. Increase scale deliberately: model rate limits, filesystem contention and inference spending still apply.

```sh
npm start -- --agents 32 --initial 4 --minutes 10 --budget 10 --out artifacts-32
```

If a network failure interrupts local export, recover from the retained disk:

```sh
npm run export -- --disk <disk-id> --out recovered
```

## What the custom harness adds

| Layer                 | Responsibility                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Pi                    | Per-agent transcript, model/tool loop and events                                                    |
| `src/harness.mjs`     | Contexts, deadlines, usage accounting, peer wakeups, lease renewal and journaling                   |
| `src/protocol.mjs`    | Public `disk` SDK calls; conditional mounts and scoped checkouts                                    |
| `runtime/fs_tools.py` | Task claims, file leases, ownership checks, expected file hashes, messages and test receipts        |
| `runtime/records.py`  | Sharded filesystem records with versions and persistent ownership generations                       |
| Archil                | Shared filesystem, delegations/conditional operations, serverless execution and coordinator sandbox |
| Agents                | Planning, interfaces, task creation/claims, code, tests, art and conflict resolution                |

The disk contains `repo/`, `coord/tasks/`, `coord/locks/`, `coord/leader.json`, `coord/messages/`, `coord/recruitment/`, `coord/test-receipts/`, `coord/guards/` and `run/`.

Guard files are permanent inodes. Native checkouts serialize a short check/update of the relevant task/file shard. They must not be replaced or held throughout inference. A separate renewable file lease spans an agent's edit; a version hash still rejects an edit prepared against stale contents. These are **harness rules**, not automatic source-code merging by Archil. All writers must use the same protocol. The model's shell tool mounts the disk read-only, so it cannot bypass file-edit tools.

A denied lease means contact the owner or choose another task. An old token means reacquire ownership. A stale SHA means reread and adapt to the peer's current content. Successful serialization does not establish compatible APIs or correct software. Tests, real browser checks and integration work are still necessary.

The current leader can declare readiness only with every noncancelled task done and its current full Node test receipt matching the exact project. That receipt **does not certify browser playability**. Context transcripts are checkpointed for inspection; this small example starts a fresh disk for each run and does not implement automatic conversation resume.

Tests run against a private copy of the recorded project bytes. Receipts compare the entire project before and after execution, including hidden files, and reject changes to the private copy. Symlinks, nonregular files and projects exceeding 2,048 files, 12 MB per file or 64 MB total are rejected. The example targets dependency-free Node tests and static browser applications, not arbitrary build environments.

This is a coordination protocol for cooperative agents, **not a security boundary against hostile generated code**. Test code shares its execution VM with the receipt helper; passing tests do not prove those tests are meaningful or tamper-proof. Use disposable disks and scoped credentials, and review generated code before running it elsewhere. The recorder isolates the application from its overlay using a scripts-only sandboxed iframe and blocks external HTTP resource requests during capture. Its local server supplies CORS headers for module imports in that opaque-origin frame; another replay host needs equivalent headers for `game/` resources.

Source files persist on the shared disk, but raw events are uploaded on harness completion and active conversations checkpoint when agents stop or park. A VM crash, OOM or controller force-stop can lose the current trace and active conversations; exporting surviving source does not guarantee a complete, replayable run. Continuous durable trace streaming and automatic resume are outside this small reference.

## Export a social video

```sh
npx playwright install chromium
npm run test:recorder
# Install FFmpeg separately, or set FFMPEG_PATH to its executable.
npm run replay -- --artifacts artifacts --out replay
npm run record -- --site replay --out swarm.mp4 --preview
npm run record -- --site replay --out swarm.mp4
```

The renderer produces a 36-second 1080-square H.264 video with 30 actual captured frames per second, large type, an evolving component diagram, individual agent status, counters and the exact exported final application. Raw event time is accelerated and labelled. Source hashes are checked after capture; the encoded video is fully decoded and its frame count verified. Review the emitted PNGs at social-feed size before sharing. `--preview` advances all game-clock steps but only saves review images.

Without allocation evidence the graph says **Tool executions**. To estimate concurrent allocated vCPU, explicitly supply verified vCPU per execution and coordinator size:

```sh
npm run replay -- --artifacts artifacts --out replay-cpu --exec-vcpu 2 --coordinator-vcpu 4
```

This reconstructs one-second mean allocation from `executeMs`, anchored at completion. Queue time and inference are excluded; it is not measured CPU utilization or an invoice.

For a green browser-verified ending, pass `--acceptance browser-acceptance.json` when preparing the replay. The proof must contain `sourceHashes` covering the exact exported project, `stableSnapshot: true`, a nonempty `checks` object with every value `true`, and empty `errors`/`warnings` arrays. The trace must also contain a passing current full Node suite. Use an independent real browser to check the task's visible behavior; do not manufacture a proof from the unit-test status. Without that proof, the ending explicitly requests browser acceptance.

The recorder advances RAF and browser timers. It is intended for local static applications; media, network services or worker clocks may need a task-specific capture strategy. `CHROME_PATH` and `FFMPEG_PATH` select existing executables. The reusable personal video skill and the Archil documentation guide are maintained separately from this code example.

## Validation and trace privacy

Before publishing traces, review their contents: raw model conversations, source and task messages can contain material specific to the task. API keys are supplied only as coordinator environment variables; agent code execution does not receive inference credentials.

Validation: the local suite exercises the real Pi loop with scripted model responses, source-version/ownership checks, production bundle parsing and replay acceptance. `npm run test:recorder` separately checks delayed initialization with frozen timers in a real browser. The conflict command has also been tested against real Archil serverless execution. Fresh cloud validation has exercised real model and tool calls; completion of a new model-driven application build has not yet been validated.

MIT licensed. Pi and other dependencies retain their respective licenses.
