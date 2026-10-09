import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeDriver, ClaudeTranscriptParser, encodeProjectDir, mergeSettings, toClaudeMcpConfig } from "./claude.ts";

test("recognizes a Claude launched with herdr-acp's settings", async () => {
  const driver = new ClaudeDriver();
  const input = { sessionId: "s1", stateDir: "/state" };
  assert.ok(await driver.launchedByHerdrAcp([["caffeinate"], ["claude", "--resume", "s1", "--settings", "/state/s1.settings.json"]], input));
  assert.ok(!(await driver.launchedByHerdrAcp([["claude", "--resume", "s1"]], input)));
});

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

test("replays a peer message without Claude's frame", () => {
  const parser = new ClaudeTranscriptParser();
  const content = "Another Claude session sent a message:\nFrom office\n\nThis came from another Claude session — not typed by your user.";
  const [event] = parser.parse({ type: "user", isMeta: true, origin: { kind: "peer" }, message: { content } }, { replay: true });
  assert.deepEqual(event, { type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "From office" } } });
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

test("turns the skill listing into available commands", () => {
  const parser = new ClaudeTranscriptParser();
  const listing = {
    type: "attachment",
    attachment: { type: "skill_listing", isInitial: true, content: "- review: Review a diff\n- plugin:deploy: Deploy it" },
  };
  const [event] = parser.parse(listing, { replay: false });
  assert.deepEqual(event, {
    type: "update",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "compact", description: "Summarize the conversation to free context" },
        { name: "review", description: "Review a diff" },
        { name: "plugin:deploy", description: "Deploy it" },
      ],
    },
  });
  assert.deepEqual(parser.parse(listing, { replay: false }), []);
});

test("ignores records written before the current turn", () => {
  const parser = new ClaudeTranscriptParser();
  const old = { type: "system", subtype: "turn_duration", timestamp: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(parser.parse(old, { replay: false, since: Date.parse("2026-06-01T00:00:00Z") }), []);
  assert.equal(parser.parse(old, { replay: false })[0]?.type, "turn_end");
});

test("reports operations on the TUI message queue", () => {
  const parser = new ClaudeTranscriptParser();
  const op = (operation: string, content?: string) =>
    parser.parse({ type: "queue-operation", operation, ...(content ? { content } : {}) }, { replay: false });
  assert.deepEqual(op("enqueue", "more"), [{ type: "queue", change: "enqueue", content: "more" }]);
  assert.deepEqual(op("dequeue"), [{ type: "queue", change: "dequeue" }]);
  assert.deepEqual(op("remove", "more"), [{ type: "queue", change: "dequeue" }]);
  assert.deepEqual(op("popAll", "more"), [{ type: "queue", change: "clear" }]);
});

test("keeps an MCP server whose env or headers are missing or null", () => {
  assert.deepEqual(
    toClaudeMcpConfig([
      { name: "artefact", command: "artefact", args: ["mcp"], env: null },
      { name: "bare", command: "bare", args: [] },
      { type: "http", name: "remote", url: "https://example.test/mcp", headers: null },
    ] as never),
    {
      mcpServers: {
        artefact: { type: "stdio", command: "artefact", args: ["mcp"], env: {} },
        bare: { type: "stdio", command: "bare", args: [], env: {} },
        remote: { type: "http", url: "https://example.test/mcp", headers: {} },
      },
    },
  );
});
