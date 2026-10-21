// Compact redundant tool observations; retain instructions, agent reasoning and actions.
export function compactHistory(messages, { maxBytes = 140000 } = {}) {
  const originalBytes = JSON.stringify(messages).length;
  if (originalBytes <= maxBytes)
    return {
      messages,
      originalBytes,
      compactedBytes: originalBytes,
      changed: false,
    };
  const passive = new Set([
      "read_context",
      "list_tasks",
      "list_files",
      "read_messages",
      "read_file",
    ]),
    latest = new Map(),
    imageIndices = [];
  let latestInbox = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "toolResult") continue;
    const text = message.content?.find((item) => item.type === "text")?.text;
    let value;
    try {
      value = JSON.parse(text);
    } catch {}
    if (Array.isArray(value?.inbox)) latestInbox = i;
    const key =
      message.toolName === "read_file"
        ? "read_file:" + value?.result?.path
        : message.toolName;
    if (passive.has(message.toolName)) latest.set(key, i);
    if (message.toolName === "view_image") imageIndices.push(i);
  }
  const keepImages = new Set(imageIndices.slice(-2));
  const successfulWrites = new Set();
  for (const m of messages)
    if (
      m.role === "toolResult" &&
      !m.isError &&
      ["write_file", "edit_file"].includes(m.toolName)
    ) {
      try {
        const v = JSON.parse(m.content?.find((c) => c.type === "text")?.text);
        if (v.ok && v.result?.sha256) successfulWrites.add(m.toolCallId);
      } catch {}
    }
  const writeCalls = messages.flatMap((m) =>
      m.role === "assistant"
        ? (m.content || []).filter(
            (c) => c.type === "toolCall" && successfulWrites.has(c.id),
          )
        : [],
    ),
    keepWrites = new Set(writeCalls.slice(-3).map((c) => c.id));
  const compacted = messages.map((message, index) => {
    if (message.role === "assistant") {
      let changed = false;
      const content = (message.content || []).map((c) => {
        if (
          c.type !== "toolCall" ||
          !successfulWrites.has(c.id) ||
          keepWrites.has(c.id)
        )
          return c;
        const args = { ...c.arguments };
        for (const key of ["content", "old_text", "new_text"])
          if (typeof args[key] === "string" && args[key].length > 1000) {
            args[key] =
              "[Earlier successful file body omitted from this model view. Exact arguments and result hashes remain in the raw trace; read the current shared file before further edits.]";
            changed = true;
          }
        return { ...c, arguments: args };
      });
      return changed ? { ...message, content } : message;
    }
    if (message.role !== "toolResult" || message.isError) return message;
    if (message.toolName === "view_image" && !keepImages.has(index))
      return {
        ...message,
        content: [
          {
            type: "text",
            text: "Earlier image pixels omitted from model context. The image and original tool evidence remain on the shared disk. View the current screenshot again when needed.",
          },
        ],
      };
    const first = message.content?.find((item) => item.type === "text");
    if (!first) return message;
    let value;
    try {
      value = JSON.parse(first.text);
    } catch {
      return message;
    }
    if (!value || typeof value !== "object") return message;
    const freshInbox = index === latestInbox ? value.inbox : undefined;
    const key =
      message.toolName === "read_file"
        ? "read_file:" + value.result?.path
        : message.toolName;
    if (passive.has(message.toolName) && latest.get(key) !== index) {
      value = {
        ok: value.ok,
        result: {
          path: value.result?.path,
          sha256: value.result?.sha256,
          exists: value.result?.exists,
        },
        contextNote:
          "Older passive filesystem snapshot omitted. Raw evidence is unchanged. Read the current shared filesystem before acting.",
      };
    } else {
      value = structuredClone(value);
      delete value.inbox;
      if (
        ["run_tests", "run_command"].includes(message.toolName) &&
        value.result
      ) {
        const r = value.result;
        value.result = {
          exitCode: r.exitCode,
          testCallId: r.testCallId,
          stableSnapshot: r.stableSnapshot,
          testedFiles: r.testedFiles,
          stdout:
            r.exitCode === 0 ? r.stdout?.slice(-1000) : r.stdout?.slice(-4000),
          stderr: r.stderr?.slice(-2000),
          contextNote:
            "Full immutable test receipt and source hash maps remain in the native trace. This is a compact historical observation; rerun current tests before readiness.",
        };
      }
    }
    if (freshInbox !== undefined) value.inbox = freshInbox;
    else delete value.inbox;
    return {
      ...message,
      content: message.content.map((item) =>
        item === first ? { ...item, text: JSON.stringify(value) } : item,
      ),
    };
  });
  return {
    messages: compacted,
    originalBytes,
    compactedBytes: JSON.stringify(compacted).length,
    changed: true,
  };
}
