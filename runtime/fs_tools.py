import os, sys, json, base64, time, hashlib, uuid, subprocess, traceback, tempfile, signal, shlex, re
from records import state as load_state, persist, guards
from pathlib import Path

ROOT = Path(os.environ.get("SWARM_ROOT", "/mnt/archil/workspace")).resolve()
REPO = ROOT / os.environ.get("SWARM_REPO", "repo")
COORD = ROOT / os.environ.get("SWARM_COORD", "coord")
START = time.perf_counter_ns()
LEADER_SECONDS = float(os.environ.get("SWARM_LEADER_SECONDS", "45"))
LOCK_SECONDS = float(os.environ.get("SWARM_LOCK_SECONDS", "180"))


def placeholder_tests(paths):
    issues = []
    for name in paths:
        p = REPO / name
        if not p.is_file():
            continue
        text = p.read_text()
        assertions = re.findall(r"\bassert\.\w+\s*\(", text)
        tautologies = re.findall(r"\bassert\.ok\s*\(\s*true\s*(?:,|\))", text)
        if assertions and len(assertions) == len(tautologies):
            issues.append(
                {
                    "path": name,
                    "reason": "Every assertion is unconditional assert.ok(true); this does not exercise delivered artifacts or behavior.",
                }
            )
    return issues


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def project_snapshot(root=None):
    """Hash every project input; reject unsupported inputs instead of omitting them."""
    root = root or REPO
    result = {}
    total = 0
    for p in sorted(root.rglob("*")):
        if p.is_symlink():
            raise ValueError("Project snapshots do not support symlinks")
        if p.is_dir():
            continue
        if not p.is_file():
            raise ValueError("Project snapshots support regular files only")
        raw = p.read_bytes()
        total += len(raw)
        if len(raw) > 12000000 or total > 64000000 or len(result) >= 2048:
            raise ValueError(
                "Project exceeds snapshot limits (2048 files, 12 MB/file, 64 MB total)"
            )
        result[str(p.relative_to(root))] = sha(raw)
    return result


def load(p, default=None):
    try:
        return json.loads(p.read_text())
    except FileNotFoundError:
        return default


def atomic(p, raw):
    p.parent.mkdir(parents=True, exist_ok=True)
    temp = p.with_name("." + p.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, p)


def put(p, obj):
    atomic(p, json.dumps(obj, separators=(",", ":")).encode())


def safe(value):
    if (
        not isinstance(value, str)
        or not value
        or value.startswith("/")
        or any(v in ("", ".", "..") for v in value.split("/"))
    ):
        raise ValueError("Use a canonical relative file path without aliases")
    p = (REPO / value).resolve()
    if not p.is_relative_to(REPO.resolve()) or not value or p == REPO:
        raise ValueError("Path must be a file within the project")
    return p


def execute(req):
    op = req["op"]
    a = req.get("args", {})
    owner = req["agent"]
    call = req["call"]
    subprocess.run(
        ["archil", "invalidate-cache", str(ROOT)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    s = load_state(COORD, load)
    now = time.time()
    allowed = guards(req, COORD.name)
    if req.get("guardPaths") is not None and set(req["guardPaths"]) != set(allowed):
        raise ValueError("Native checkout scope does not match the operation")
    if s.get("ready") and op not in [
        "read_context",
        "read_file",
        "list_files",
        "list_tasks",
        "read_task",
        "read_messages",
        "run_tests",
        "run_command",
        "send_message",
        "request_browser_check",
        "renew_leases",
    ]:
        raise ValueError("Project is frozen after verified readiness")

    def next_token():
        s["sequence"] = (
            max(
                [
                    s["sequence"],
                    (s.get("leader") or {}).get("term", 0),
                    *s["tasks"].fences(),
                    *s["locks"].fences(),
                ]
            )
            + 1
        )
        return s["sequence"]

    def leader_ok(term):
        l = s.get("leader")
        if not l or l["owner"] != owner or l["term"] != term or l["expiresAt"] <= now:
            raise ValueError("Leadership lease or term is stale")

    def lock_ok(path, token):
        l = s["locks"].get(path)
        if not l or l["owner"] != owner or l["token"] != token or l["expiresAt"] <= now:
            raise ValueError("File lock is absent, expired, or fenced out")

    def lock_path(path):
        p = safe(path)
        if not p.suffix or path == "BRIEF.md":
            raise ValueError(
                "Lock an individual writable project file, not a directory or the specification"
            )
        return p

    def read_result(path):
        p = safe(path)
        if not p.exists():
            return {"path": path, "exists": False, "sha256": None, "content": None}
        raw = p.read_bytes()
        if p.suffix.lower() in [".png", ".jpg", ".jpeg", ".webp"]:
            try:
                text = raw.decode() if len(raw) <= 100000 else None
            except UnicodeDecodeError:
                text = None
            if text is None:
                return {
                    "path": path,
                    "exists": True,
                    "sha256": sha(raw),
                    "bytes": len(raw),
                    "content": None,
                    "encoding": "binary",
                    "nextAction": "Use view_image for pixels; this SHA supports fenced asset replacement.",
                }
        if len(raw) > 100000:
            raise ValueError("File exceeds read limit")
        return {
            "path": path,
            "exists": True,
            "sha256": sha(raw),
            "content": raw.decode(),
        }

    mut = op in [
        "elect_leader",
        "create_task",
        "create_tasks",
        "split_task",
        "finalize_split",
        "claim_task",
        "acquire_lock",
        "release_lock",
        "write_file",
        "send_message",
        "complete_task",
        "heartbeat",
        "resign_leader",
        "abandon_task",
        "update_task",
        "cancel_task",
        "propose_task",
        "heartbeat_all",
        "renew_leases",
        "edit_file",
        "publish_image",
        "request_browser_check",
        "declare_ready",
    ]
    receipt = COORD / "receipts" / f"{call}.json"
    if mut and receipt.exists():
        return load(receipt)
    if op == "read_context":
        r = {
            "capacity": load(COORD / "capacity.json", {}),
            "brief": read_result("BRIEF.md"),
            "tasks": list(s["tasks"].values()),
            "leader": (
                s.get("leader")
                if (s.get("leader") or {}).get("expiresAt", 0) > now
                else None
            ),
            "files": [
                str(p.relative_to(REPO))
                for p in REPO.rglob("*")
                if p.is_file()
                and not any(v.startswith(".") for v in p.relative_to(REPO).parts)
            ],
        }
    elif op == "read_file":
        r = read_result(a["path"])
    elif op == "list_files":
        r = {
            "files": [
                {"path": str(p.relative_to(REPO)), "bytes": p.stat().st_size}
                for p in sorted(REPO.rglob("*"))
                if p.is_file()
                and not any(
                    v.startswith(".") or v == "node_modules"
                    for v in p.relative_to(REPO).parts
                )
            ][:200]
        }
    elif op == "list_tasks":
        r = {
            "tasks": list(s["tasks"].values()),
            "leader": (
                s.get("leader")
                if (s.get("leader") or {}).get("expiresAt", 0) > now
                else None
            ),
            "ready": s.get("ready"),
            "now": now,
            "capacity": load(COORD / "capacity.json", {}),
        }
    elif op == "read_task":
        task = s["tasks"].get(a["task_id"])
        if not task:
            raise ValueError("Unknown task")
        r = {"task": task}
    elif op == "elect_leader":
        l = s.get("leader")
        if l and l["expiresAt"] > now and l["owner"] != owner:
            r = {"won": False, "leader": l}
        else:
            if not l or l["owner"] != owner or l["expiresAt"] <= now:
                l = {
                    "owner": owner,
                    "term": next_token(),
                    "expiresAt": now + LEADER_SECONDS,
                }
            else:
                l["expiresAt"] = now + LEADER_SECONDS
            s["leader"] = l
            r = {"won": True, "leader": l}
    elif op == "resign_leader":
        leader_ok(a["term"])
        s["leader"]["expiresAt"] = now
        s["leader"]["resigned"] = True
        r = {"resigned": True}
    elif op in ["create_task", "propose_task", "create_tasks"]:
        tasks = a.get("tasks") if op == "create_tasks" else [a["task"]]
        if not tasks or len(tasks) > 32:
            raise ValueError("Create one to thirty-two useful tasks per call")
        parent = None
        created = []
        for t in tasks:
            if not t["id"].replace("-", "").replace("_", "").isalnum():
                raise ValueError("Invalid task ID")
            if t["id"] in s["tasks"]:
                continue
            if not t.get("files"):
                raise ValueError(
                    "Task needs concrete source, art, test or report file paths; empty work is not runnable"
                )
            for resource in t["files"]:
                lock_path(resource)
            row = {
                "id": t["id"],
                "title": t["title"][:120],
                "description": t["description"][:5000],
                "files": t["files"],
                "dependencies": t.get("dependencies", []),
                "status": "open",
                "owner": None,
                "claimToken": None,
                "expiresAt": 0,
                "createdBy": owner,
                "parentId": a.get("parent_id"),
                "createdAt": now,
            }
            s["tasks"][t["id"]] = row
            created.append(row)
        r = {"created": created}
        if op in ["create_task", "propose_task"]:
            r.update(task=s["tasks"][tasks[0]["id"]], createdNew=bool(created))
    elif op == "finalize_split":
        parent = s["tasks"].get(a["task_id"])
        if (
            not parent
            or parent.get("owner") != owner
            or parent.get("claimToken") != a["claim_token"]
            or parent["expiresAt"] <= now
        ):
            raise ValueError("Only a current task owner can split its task")
        ids = a["child_ids"]
        if not ids or parent["id"] in ids:
            raise ValueError("Supply child task IDs, not the parent")
        children = [s["tasks"].get(i) for i in ids]
        if any(not t or parent["id"] in t.get("dependencies", []) for t in children):
            raise ValueError(
                "Publish valid children before releasing the parent; children cannot depend on parent"
            )
        parent.update(
            status="open",
            owner=None,
            claimToken=None,
            expiresAt=0,
            dependencies=list(dict.fromkeys(parent.get("dependencies", []) + ids)),
            splitBy=owner,
        )
        r = {"task": parent, "childrenPublished": ids}
    elif op in ["update_task", "cancel_task"]:
        t = s["tasks"].get(a["task_id"])
        if not t:
            raise ValueError("Task not found")
        live = t.get("status") == "working" and t.get("expiresAt", 0) > now
        owns = (
            live
            and t.get("owner") == owner
            and t.get("claimToken") == a.get("claim_token")
        )
        authored = not live and owner in [t.get("createdBy"), t.get("owner")]
        if a.get("expected_version") is not None and a["expected_version"] != t.get(
            "version"
        ):
            raise ValueError("Task version changed; reread before refining idle work")
        cas = (
            not live
            and a.get("expected_version") is not None
            and a["expected_version"] == t.get("version")
        )
        if not (owns or authored or cas):
            raise ValueError(
                "Current owners use claim_token; any worker can refine idle work with a fresh expected_version"
            )
        if live and t.get("owner") != owner:
            raise ValueError(
                "Ask the current owner to abandon before replacing an active claim"
            )
        if op == "cancel_task":
            t.update(
                status="cancelled",
                cancelReason=a["reason"],
                cancelledBy=owner,
                cancelledAt=now,
            )
        else:
            for field in ["description", "files", "dependencies"]:
                if field in a:
                    t[field] = a[field]
            for resource in t["files"]:
                lock_path(resource)
            if a.get("reopen"):
                t.update(status="open", owner=None, claimToken=None, expiresAt=0)
        r = {"task": t}
    elif op == "claim_task":
        target = s["tasks"].get(a["task_id"])
        candidates = [
            t
            for t in ([target] if target else [])
            if (
                t["status"] == "open"
                or t["status"] == "working"
                and t["expiresAt"] <= now
            )
            and all(
                s["tasks"].get(dep, {}).get("status") == "done"
                for dep in t.get("dependencies", [])
            )
        ]
        if not candidates:
            r = {
                "task": None,
                "reason": "This specific task is owned, finished, missing or dependency-blocked. Inspect ready work or create a useful task yourself.",
            }
        else:
            t = candidates[0]
            t.update(
                status="working",
                owner=owner,
                claimToken=next_token(),
                expiresAt=now + 240,
            )
            r = {"task": t}
    elif op == "abandon_task":
        t = s["tasks"].get(a["task_id"])
        if not t or t["owner"] != owner or t["claimToken"] != a["claim_token"]:
            raise ValueError("Task claim is stale")
        t.update(status="open", owner=None, claimToken=None, expiresAt=0)
        r = {
            "abandoned": True,
            "task": t,
            "nextAction": "Abandoned work becomes OPEN and wakes peers. If this scope is genuinely duplicate/superseded, cancel_task retires it; state the reason.",
        }
    elif op == "acquire_lock":
        path = a["path"]
        lock_path(path)
        l = s["locks"].get(path)
        if l and l["expiresAt"] > now and l["owner"] != owner:
            r = {"acquired": False, "lock": l}
        else:
            if not l or l["owner"] != owner or l["expiresAt"] <= now:
                l = {
                    "path": path,
                    "owner": owner,
                    "token": next_token(),
                    "expiresAt": now + LOCK_SECONDS,
                }
            else:
                l["expiresAt"] = now + LOCK_SECONDS
            s["locks"][path] = l
            r = {"acquired": True, "path": path, "lock": l}
    elif op == "release_lock":
        lock_path(a["path"])
        lock_ok(a["path"], a["token"])
        del s["locks"][a["path"]]
        r = {"released": True}
    elif op == "renew_leases":
        owners = set(a["owners"])
        renewed = 0
        if (
            a.get("leader")
            and s.get("leader")
            and s["leader"]["owner"] in owners
            and s["leader"]["expiresAt"] > now
        ):
            s["leader"]["expiresAt"] = now + LEADER_SECONDS
            renewed += 1
        for path in a.get("paths", []):
            l = s["locks"].get(path)
            if l and l["owner"] in owners and l["expiresAt"] > now:
                l["expiresAt"] = now + LOCK_SECONDS
                renewed += 1
        for tid in a.get("task_ids", []):
            t = s["tasks"].get(tid)
            if (
                t
                and t.get("owner") in owners
                and t["status"] == "working"
                and t["expiresAt"] > now
            ):
                t["expiresAt"] = now + 240
                renewed += 1
        r = {"renewedLeases": renewed}
    elif op in ["write_file", "edit_file"]:
        path = a["path"]
        p = lock_path(path)
        lock_ok(path, a["token"])
        if op == "edit_file":
            original = p.read_text()
            if original.count(a["old_text"]) != 1:
                raise ValueError("old_text must match exactly once; reread the file")
            a["content"] = original.replace(a["old_text"], a["new_text"], 1)
        content = a["content"]
        if content.startswith("data:image/"):
            match = re.fullmatch(
                r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)", content
            )
            if (
                not match
                or p.suffix.lower()
                not in {"png": [".png"], "jpeg": [".jpg", ".jpeg"], "webp": [".webp"]}[
                    match[1]
                ]
            ):
                raise ValueError("Base64 image data URLs require a raster asset path")
            raw = base64.b64decode("".join(match[2].split()), validate=True)
            valid = (
                (match[1] == "png" and raw.startswith(b"\x89PNG\r\n\x1a\n"))
                or (match[1] == "jpeg" and raw.startswith(b"\xff\xd8"))
                or (
                    match[1] == "webp"
                    and raw.startswith(b"RIFF")
                    and raw[8:12] == b"WEBP"
                )
            )
            if not valid:
                raise ValueError(
                    "Image bytes do not match the declared data URL format"
                )
        else:
            raw = content.encode()
        if p.suffix.lower() == ".png" and not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError(
                "A .png asset needs PNG bytes; use a .svg path for SVG source or a validated PNG data URL for generated raster art"
            )
        if len(raw) > 100000:
            raise ValueError("File exceeds write limit")
        before = p.read_bytes() if p.exists() else None
        actual = sha(before) if before is not None else None
        if actual != a.get("expected_sha256") and actual != sha(raw):
            raise ValueError("File changed since your read; reread before editing")
        atomic(p, raw)
        r = {
            "path": path,
            "beforeSha256": actual,
            "sha256": sha(raw),
            "bytes": len(raw),
            "fence": a["token"],
            "content": a["content"],
        }
    elif op == "declare_ready":
        leader_ok(a["term"])
        if not s["tasks"] or any(
            t["status"] not in ["done", "cancelled"] for t in s["tasks"].values()
        ):
            raise ValueError("Finish or repair all shared tasks first")
        proof = load(COORD / "test-receipts" / f"{a['test_call_id']}.json")
        if proof and proof.get("testQualityIssues"):
            raise ValueError(
                "Replace tautological placeholder tests with executable behavior checks: "
                + json.dumps(proof["testQualityIssues"])
            )
        if (
            not proof
            or proof["agent"] != owner
            or proof["exitCode"] != 0
            or not proof.get("stableSnapshot")
        ):
            raise ValueError("Leader must run and pass the current full test suite")
        alltests = sorted(
            str(p.relative_to(REPO)) for p in (REPO / "tests").rglob("*.test.mjs")
        )
        if not alltests or sorted(proof.get("testedFiles", [])) != alltests:
            raise ValueError("Run all tests using test_files=[]")
        if project_snapshot() != proof["files"]:
            raise ValueError("Project changed after tests; rerun full tests")
        s["ready"] = {
            "agent": owner,
            "at": now,
            "summary": a["summary"],
            "testCallId": a["test_call_id"],
            "validation": "Current full Node suite only; no browser-playability claim",
        }
        r = s["ready"]
    elif op == "send_message":
        if (
            not isinstance(a.get("to"), str)
            or not a["to"].replace("-", "").replace("_", "").isalnum()
            or len(a["to"]) > 80
        ):
            raise ValueError("Use one canonical recipient ID or all")
        if len(a["body"]) > 3000:
            raise ValueError("Message too long")
        m = {"id": call, "from": owner, "to": a["to"], "body": a["body"], "at": now}
        put(COORD / "messages" / a["to"] / f"{call}.json", m)
        r = m
    elif op == "read_messages":
        rows = [
            load(p)
            for recipient in [owner, "all"]
            for p in (COORD / "messages" / recipient).glob("*.json")
        ]
        r = {
            "messages": sorted(
                [m for m in rows if m["to"] in [owner, "all"]], key=lambda m: m["at"]
            )[-20:]
        }
    elif op == "complete_task":
        t = s["tasks"].get(a["task_id"])
        if (
            not t
            or t["owner"] != owner
            or t["claimToken"] != a["claim_token"]
            or t["expiresAt"] <= now
        ):
            raise ValueError("Task claim is stale")
        proof = load(COORD / "test-receipts" / f"{a['test_call_id']}.json")
        if proof and proof.get("testQualityIssues"):
            raise ValueError(
                "Task receipt contains tautological placeholder tests: "
                + json.dumps(proof["testQualityIssues"])
            )
        if not proof or proof["exitCode"] != 0 or proof["agent"] != owner:
            raise ValueError("Provide a successful actual run_command call ID")
        if not proof.get("stableSnapshot"):
            raise ValueError(
                "Source changed while testing or receipt predates snapshot validation; rerun tests"
            )
        required = [p for p in t["files"] if p.endswith(".test.mjs")]
        if not proof.get("testedFiles") or not set(required).issubset(
            proof.get("testedFiles", [])
        ):
            raise ValueError(
                "Use run_tests with every declared task test file before completing"
            )
        for path in t["files"]:
            p = safe(path)
            if not p.exists() or proof["files"].get(path) != sha(p.read_bytes()):
                raise ValueError(
                    "Task files changed after testing, or test receipt does not cover them: "
                    + path
                )
        t.update(
            status="done",
            summary=a["summary"][:2000],
            testCallId=a["test_call_id"],
            completedAt=now,
        )
        r = {"task": t}
    elif op in ["run_command", "run_tests"]:
        # This branch is invoked with the entire disk mounted read-only.
        tested = []
        if op == "run_tests":
            tested = a.get("test_files") or sorted(
                str(p.relative_to(REPO)) for p in (REPO / "tests").rglob("*.test.mjs")
            )
            if not tested or len(tested) > 512:
                raise ValueError("Specify between one and 512 existing test files")
            for f in tested:
                if (
                    not f.startswith("tests/")
                    or not f.endswith(".test.mjs")
                    or not safe(f).is_file()
                ):
                    raise ValueError("Tests must be existing tests/*.test.mjs files")
            command = shlex.join(["node", "--test", *tested])
        else:
            command = a["command"]
        if len(command) > 4000:
            raise ValueError("Command too long")

        before_files = project_snapshot()
        began = time.perf_counter_ns()
        with tempfile.TemporaryDirectory(
            prefix="swarm-tests-"
        ) as temp_dir, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            execution_root = REPO
            if tested:
                # A read-only mount is live, not a point-in-time source snapshot.
                # Run tests against exactly the bytes recorded in this receipt.
                execution_root = Path(temp_dir) / "repo"
                execution_root.mkdir()
                for name, expected in before_files.items():
                    source = safe(name)
                    if source.is_symlink():
                        raise ValueError("Project snapshots do not support symlinks")
                    raw = source.read_bytes()
                    if sha(raw) != expected:
                        raise ValueError(
                            "Project changed while creating test snapshot; retry"
                        )
                    dest = execution_root / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(raw)
                if project_snapshot(execution_root) != before_files:
                    raise ValueError("Test snapshot differs from recorded source")
            child = subprocess.Popen(
                ["bash", "-lc", "ulimit -f 8192; " + command],
                cwd=execution_root,
                stdout=out,
                stderr=err,
                start_new_session=True,
                env={**os.environ, "HOME": "/tmp", "TMPDIR": "/tmp", "CI": "true"},
            )
            timed_out = False
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)
            out.seek(0, 2)
            out.seek(
                max(0, out.tell() - (12000000 if a.get("asset_output") else 14000))
            )
            err.seek(0, 2)
            err.seek(max(0, err.tell() - 6000))
            r = {
                "exitCode": 124 if timed_out else child.returncode,
                "stdout": out.read().decode(errors="replace"),
                "stderr": err.read().decode(errors="replace")
                + ("\nCommand timed out after 30 seconds" if timed_out else ""),
            }
            tested_files = project_snapshot(execution_root)
        subprocess.run(
            ["archil", "invalidate-cache", str(ROOT)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        after_files = project_snapshot()
        stable = before_files == tested_files == after_files
        if tested:
            r.update(
                testQualityIssues=placeholder_tests(tested),
                testQualityAccepted=not placeholder_tests(tested),
            )
        r.update(
            workingDirectory=str(REPO),
            executionSnapshot=bool(tested),
            writePolicy="Project is read-only for command execution. Use write_file with a lease for project changes; /tmp scripts need absolute imports. For inline module scripts, node --input-type=module via stdin resolves ./features relative to the project.",
            command=command,
            commandMs=(time.perf_counter_ns() - began) / 1e6,
            agent=owner,
            testCallId=call,
            files=after_files,
            beforeFiles=before_files,
            stableSnapshot=stable,
            testedFiles=tested,
        )
    else:
        raise ValueError("Unknown tool operation")
    s["clock"] = now
    direct = [
        load(p)
        for recipient in [owner, "all"]
        for p in (COORD / "messages" / recipient).glob("*.json")
    ]
    inbox = sorted(
        [m for m in direct if m and m.get("to") in [owner, "all"]],
        key=lambda m: m["at"],
    )[-6:]
    # Surface related live scopes so peers can reconcile them, without host assignment.
    related = set((a.get("task") or {}).get("files", [])) | set(
        (r.get("task") or {}).get("files", [])
    )
    if op in ["acquire_lock", "write_file", "edit_file"]:
        related.add(a["path"])
    if related:
        overlaps = [
            {
                "id": t["id"],
                "owner": t.get("owner"),
                "status": t["status"],
                "overlappingFiles": sorted(related & set(t["files"])),
            }
            for t in s["tasks"].values()
            if t["status"] not in ["done", "cancelled"]
            and t.get("owner") != owner
            and related & set(t["files"])
        ]
        if overlaps:
            r["overlappingWork"] = {
                "tasks": overlaps[:12],
                "total": len(overlaps),
                "nextAction": "These are agent-created overlapping scopes, not assignments. Contact the listed owners/leader through filesystem messages; agree interfaces, reuse or reconcile duplicate scopes before replacing shared modules.",
            }
    leader = s.get("leader")
    live = bool(leader and leader.get("expiresAt", 0) > now)
    result = {
        "ok": True,
        "result": r,
        "leader": leader if live else None,
        "leadership": {
            "live": live,
            "remainingSeconds": max(0, (leader or {}).get("expiresAt", 0) - now),
            "expiredOwner": leader.get("owner") if leader and not live else None,
            "nextAction": (
                "A live leader exists"
                if live
                else "No live leader. Any peer may elect_leader; task creation does not need leadership."
            ),
        },
        "serverTime": now,
        "inbox": inbox,
        "capacity": load(COORD / "capacity.json", {}),
    }
    if mut:
        persist(s, COORD, put, load, allowed)
        put(receipt, result)
        subprocess.run(
            ["archil", "sync", str(ROOT)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    return result


if __name__ == "__main__":
    try:
        req = json.loads(base64.b64decode(sys.argv[1]))
        out = execute(req)
    except Exception as e:
        out = {"ok": False, "error": str(e)}
    out["handlerMs"] = (time.perf_counter_ns() - START) / 1e6
    print(json.dumps(out, separators=(",", ":")))
