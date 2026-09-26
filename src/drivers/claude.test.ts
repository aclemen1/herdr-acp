import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeTranscriptParser, encodeProjectDir, mergeSettings, toClaudeMcpConfig } from "./claude.ts";

const assistant = (id: string, content: unknown[], stop = "tool_use") => ({
  type: "assistant",
  isSidechain: false,
  message: {
    id,
    role: "assistant",
    content,
    stop_reason: stop,
    usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
  },
});

test("maps a live turn to ACP updates and signals the end of turn", () => {
  const parser = new ClaudeTranscriptParser();
  const records = [
    { type: "user", message: { role: "user", content: "Run pwd" } },
    assistant("m1", [{ type: "thinking", thinking: "Need pwd." }]),
    assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd", description: "Print cwd" } }]),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "/tmp", is_error: false }] } },
    assistant("m2", [{ type: "text", text: "Done." }], "end_turn"),
    { type: "system", subtype: "turn_duration", durationMs: 1000 },
  ];
  const events = records.flatMap((record) => parser.parse(record, { replay: false }));
  const updates = events.flatMap((event) => (event.type === "update" ? [event.update.sessionUpdate] : []));
  assert.deepEqual(updates, ["agent_thought_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
  assert.equal(events.at(-1)?.type, "turn_end");

  const toolCall = events.find((event) => event.type === "update" && event.update.sessionUpdate === "tool_call");
  assert.deepEqual(toolCall, {
    type: "update",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Print cwd",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "pwd", description: "Print cwd" },
    },
  });
});

test("reports a tool call announced by a hook as an update", () => {
  const parser = new ClaudeTranscriptParser();
  parser.markAnnounced("t9");
  const [event] = parser.parse(assistant("m1", [{ type: "tool_use", id: "t9", name: "Write", input: { file_path: "/x.txt" } }]), {
    replay: false,
  });
  assert.equal(event?.type === "update" && event.update.sessionUpdate, "tool_call_update");
});

test("replays user messages but skips meta and command records", () => {
  const parser = new ClaudeTranscriptParser();
  const replay = { replay: true };
  assert.equal(parser.parse({ type: "user", message: { content: "Hello" } }, replay).length, 1);
  assert.equal(parser.parse({ type: "user", isMeta: true, message: { content: "meta" } }, replay).length, 0);
  assert.equal(parser.parse({ type: "user", message: { content: "<command-name>/clear</command-name>" } }, replay).length, 0);
  assert.equal(parser.parse({ type: "user", message: { content: "Hello" } }, { replay: false }).length, 0);
});

test("ignores sidechain records and converts TodoWrite to a plan", () => {
  const parser = new ClaudeTranscriptParser();
  assert.deepEqual(parser.parse({ ...assistant("s", [{ type: "text", text: "x" }]), isSidechain: true }, { replay: false }), []);
  const [event] = parser.parse(
    assistant("m3", [{ type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: [{ content: "A", status: "in_progress" }] } }]),
    { replay: false },
  );
  assert.deepEqual(event, {
    type: "update",
    update: { sessionUpdate: "plan", entries: [{ content: "A", status: "in_progress", priority: "medium" }] },
  });
});

test("reports usage per assistant message", () => {
  const parser = new ClaudeTranscriptParser();
  const events = parser.parse(assistant("m4", [{ type: "text", text: "hi" }], "end_turn"), { replay: false });
  assert.deepEqual(events.find((event) => event.type === "usage"), {
    type: "usage",
    messageId: "m4",
    usage: { inputTokens: 2, outputTokens: 10, cachedReadTokens: 100, cachedWriteTokens: 5, thoughtTokens: 0 },
  });
});

test("encodes project directories like Claude Code", () => {
  assert.equal(encodeProjectDir("/private/tmp/a.b/c_d"), "-private-tmp-a-b-c-d");
});

test("converts ACP MCP servers to a Claude MCP config", () => {
  assert.deepEqual(
    toClaudeMcpConfig([
      { name: "fs", command: "mcp-fs", args: ["--root", "/"], env: [{ name: "TOKEN", value: "t" }] },
      { type: "http", name: "remote", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
    ]),
    {
      mcpServers: {
        fs: { type: "stdio", command: "mcp-fs", args: ["--root", "/"], env: { TOKEN: "t" } },
        remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
      },
    },
  );
});

test("merges user settings with herdr-acp hooks", () => {
  const merged = mergeSettings(
    { permissions: { ask: ["Bash(touch:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash" }] } },
    { hooks: { PreToolUse: [{ matcher: "*" }], MessageDisplay: [{}] } },
  );
  assert.deepEqual(merged, {
    permissions: { ask: ["Bash(touch:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash" }, { matcher: "*" }], MessageDisplay: [{}] },
  });
});

test("skips synthetic messages and results of settled tool calls", () => {
  const parser = new ClaudeTranscriptParser();
  const synthetic = { ...assistant("x", [{ type: "text", text: "No response requested." }]), message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } };
  assert.deepEqual(parser.parse(synthetic, { replay: false }), []);
  parser.markAnnounced("t5");
  parser.parse(assistant("m5", [{ type: "tool_use", id: "t5", name: "ExitPlanMode", input: {} }]), { replay: false });
  parser.markSettled("t5");
  const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t5", content: "denied", is_error: true }] } };
  assert.deepEqual(parser.parse(result, { replay: false }), []);
});
