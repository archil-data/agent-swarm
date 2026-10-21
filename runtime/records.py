"""Filesystem record store. Native conditional checkouts serialize only touched shards."""

import json, time, hashlib, uuid, os
from collections.abc import MutableMapping
from pathlib import Path

TASK_SHARDS = 32
FILE_SHARDS = 32


def digest(key):
    return hashlib.sha256(key.encode()).hexdigest()


def bucket(kind, key):
    return int(digest(key)[:8], 16) % (TASK_SHARDS if kind == "tasks" else FILE_SHARDS)


def all_guards(prefix="coord"):
    return [f"{prefix}/guards/leader"] + [
        f"{prefix}/guards/{kind}-{i:02}"
        for kind, n in [("tasks", TASK_SHARDS), ("files", FILE_SHARDS)]
        for i in range(n)
    ]


def guards(req, prefix="coord"):
    op = req["op"]
    a = req.get("args", {})
    items = []
    if op in ["elect_leader", "resign_leader"]:
        items = [f"{prefix}/guards/leader"]
    elif op in ["create_task", "propose_task"]:
        items = [f"{prefix}/guards/tasks-{bucket('tasks',a['task']['id']):02}"]
    elif op in ["create_tasks", "split_task"]:
        ids = [t["id"] for t in a["tasks"]] + (
            [a["task_id"]] if op == "split_task" else []
        )
        items = [f"{prefix}/guards/tasks-{bucket('tasks',i):02}" for i in ids]
    elif op in [
        "claim_task",
        "abandon_task",
        "update_task",
        "cancel_task",
        "complete_task",
        "finalize_split",
    ]:
        items = [f"{prefix}/guards/tasks-{bucket('tasks',a['task_id']):02}"]
    elif op in [
        "acquire_lock",
        "release_lock",
        "write_file",
        "edit_file",
        "publish_image",
    ]:
        items = [f"{prefix}/guards/files-{bucket('files',a['path']):02}"]
    elif op == "renew_leases":
        items = (
            [
                f"{prefix}/guards/tasks-{bucket('tasks',i):02}"
                for i in a.get("task_ids", [])
            ]
            + [
                f"{prefix}/guards/files-{bucket('files',i):02}"
                for i in a.get("paths", [])
            ]
            + ([f"{prefix}/guards/leader"] if a.get("leader") else [])
        )
    elif op == "declare_ready":
        items = all_guards(prefix)
    return sorted(set(items))


class Records(MutableMapping):
    def __init__(self, folder, keyfield):
        self.folder = folder
        self.keyfield = keyfield
        self.cache = {}
        self.original = {}

    def file(self, key):
        return self.folder / (digest(key) + ".json")

    def _load(self, key):
        if key not in self.cache:
            try:
                raw = self.file(key).read_text()
                value = json.loads(raw)
            except FileNotFoundError:
                raw = None
                value = None
            self.original[key] = raw
            self.cache[key] = value
        return self.cache[key]

    def __getitem__(self, key):
        v = self._load(key)
        if v is None or v.get("_deleted"):
            raise KeyError(key)
        return v

    def __setitem__(self, key, v):
        self._load(key)
        self.cache[key] = v

    def __delitem__(self, key):
        old = self[key]
        self.cache[key] = {
            "_deleted": True,
            self.keyfield: key,
            "lastFence": max(
                old.get("lastFence", 0), old.get("token", 0), old.get("claimToken") or 0
            ),
            "version": old.get("version", 0),
        }

    def __iter__(self):
        keys = set(self.cache)
        if self.folder.exists():
            for p in self.folder.glob("*.json"):
                try:
                    v = json.loads(p.read_text())
                    key = v[self.keyfield]
                except (FileNotFoundError, KeyError, json.JSONDecodeError):
                    continue
                if key not in self.cache:
                    self.cache[key] = v
                    self.original[key] = json.dumps(v, separators=(",", ":"))
                keys.add(key)
        return iter(
            sorted(
                k
                for k in keys
                if self.cache[k] is not None and not self.cache[k].get("_deleted")
            )
        )

    def __len__(self):
        return sum(1 for _ in self)

    def fences(self):
        return [
            max(
                v.get("lastFence", 0),
                v.get("token", 0),
                v.get("claimToken") or 0,
                v.get("version", 0),
            )
            for v in self.cache.values()
            if v
        ]

    def flush(self, put, allowed, prefix, kind):
        for key, v in sorted(
            self.cache.items(), key=lambda item: self.original[item[0]] is not None
        ):
            if v is None:
                continue
            raw = json.dumps(v, separators=(",", ":"))
            if raw == self.original[key]:
                continue
            guard = f"{prefix}/guards/{kind}-{bucket('tasks' if kind=='tasks' else 'files',key):02}"
            if guard not in allowed:
                raise ValueError("Mutation lacks native resource checkout: " + guard)
            before = json.loads(self.original[key]) if self.original[key] else {}
            v["version"] = before.get("version", 0) + 1
            v["lastFence"] = max(
                before.get("lastFence", 0),
                v.get("lastFence", 0),
                v.get("token", 0),
                v.get("claimToken") or 0,
            )
            v["updatedAt"] = time.time()
            put(self.file(key), v)


def state(coord, load):
    leader = load(coord / "leader.json")
    ready = load(coord / "ready.json")
    return {
        "sequence": 0,
        "clock": 0,
        "leader": leader,
        "ready": ready,
        "tasks": Records(coord / "tasks", "id"),
        "locks": Records(coord / "locks", "path"),
        "_original": json.loads(json.dumps({"leader": leader, "ready": ready})),
    }


def persist(s, coord, put, load, allowed):
    prefix = coord.name
    s["tasks"].flush(put, allowed, prefix, "tasks")
    s["locks"].flush(put, allowed, prefix, "files")
    for field in ["leader", "ready"]:
        if s.get(field) != s["_original"].get(field):
            if field == "leader" and f"{prefix}/guards/leader" not in allowed:
                raise ValueError("Leadership mutation lacks native checkout")
            if field == "ready" and set(all_guards(prefix)) - set(allowed):
                raise ValueError("Readiness requires a full mutation barrier")
            put(coord / (field + ".json"), s[field])
