import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { HookHost, StatusReport } from "./types.ts";
import { activeBranch, createPiHookHandler, encodePiProjectDir, PiDriver, piConfigOptions, PiTranscriptParser } from "./pi.ts";

test("encodes project directories like Pi", () => {
  assert.equal(encodePiProjectDir("/Users/a/code/x"), "--Users-a-code-x--");
});

test("derives the session id from a Pi session file path", () => {
  assert.equal(
    new PiDriver().sessionIdFromRef({ kind: "path", value: "/s/--x--/2026-09-18T00-59-06-092Z_01a0b206-33ec.jsonl" }),
    "01a0b206-33ec",
  );
});

test("maps Pi messages to ACP updates with usage and diffs", () => {
  const parser = new PiTranscriptParser();
  const at = "2026-09-27T00:00:00.000Z";
  const events = [
    { type: "message", id: "u", timestamp: at, message: { role: "user", content: [{ type: "text", text: "go" }] } },
    {
      type: "message",
      id: "a1",
      timestamp: at,
      message: {
        role: "assistant",
        responseId: "r1",
        stopReason: "toolUse",
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, reasoning: 3 },
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "toolCall", id: "t1", name: "edit", arguments: { path: "/a.ts", edits: [{ oldText: "x", newText: "y" }] } },
        ],
      },
    },
    { type: "message", id: "r", timestamp: at, message: { role: "toolResult", toolCallId: "t1", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] } },
  ].flatMap((entry) => parser.parse(entry, { replay: false }));
  const updates = events.flatMap((event) => (event.type === "update" ? [event.update] : []));
  assert.deepEqual(
    updates.map((item) => item.sessionUpdate),
    ["agent_thought_chunk", "tool_call", "tool_call_update"],
  );
  const call = updates[1] as { content?: unknown; kind?: string };
  assert.equal(call.kind, "edit");
  assert.deepEqual(call.content, [{ type: "diff", path: "/a.ts", oldText: "x", newText: "y" }]);
  assert.deepEqual((updates[2] as { content?: unknown }).content, undefined);
  assert.deepEqual(events.find((event) => event.type === "usage"), {
    type: "usage",
    messageId: "r1",
    usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, cachedWriteTokens: 2, thoughtTokens: 3 },
  });
});

test("replays only the active branch of the session tree", () => {
  const records = [
    { type: "session", id: "h" },
    { type: "message", id: "1", parentId: null },
    { type: "message", id: "2", parentId: "1" },
    { type: "message", id: "3", parentId: "1" },
  ];
  assert.deepEqual(
    activeBranch(records).map((entry) => (entry as { id: string }).id),
    ["1", "3"],
  );
});

test("groups models by provider in the config options", () => {
  const options = piConfigOptions(
    { mode: "default", model: "xai/grok-4.6", effort: "high" },
    new PiDriver().availableModes(),
    "Grok 4.6",
    [
      { provider: "xai", id: "grok-4.6" },
      { provider: "anthropic", id: "claude-opus-5" },
    ],
  );
  const model = options.find((option) => option.id === "model");
  assert.ok(model?.type === "select");
  assert.equal(model.currentValue, "xai/grok-4.6");
  assert.deepEqual(
    (model.options as { group: string }[]).map((group) => group.group),
    ["default", "xai", "anthropic"],
  );
});

function host(mode: string, choice: string | null) {
  const log = { updates: [] as SessionUpdate[], streamed: [] as string[], statuses: [] as StatusReport[], ended: false };
  const fake = {
    sessionId: "s",
    notify: async (update: SessionUpdate) => {
      log.updates.push(update);
    },
    announceToolCall: () => {},
    settleToolCall: () => {},
    streamText: async (text: string, kind?: string) => {
      log.streamed.push(`${kind ?? "message"}:${text}`);
    },
    currentMode: () => mode,
    endTurn: () => {
      log.ended = true;
    },
    requestPermission: async () => choice,
    availableModeIds: () => ["default", "ask"],
    reportMode: async () => {},
    reportStatus: async (status: StatusReport) => {
      log.statuses.push(status);
    },
    takePendingMode: () => null,
    restorePendingMode: () => {},
    continueWithMode: () => {},
    elicit: async () => null,
    markCancelled: () => {},
    envApplied: () => {},
  } satisfies HookHost;
  return { fake, log };
}

test("blocks a tool call rejected in ask mode", async () => {
  const { fake } = host("ask", "reject");
  const output = await createPiHookHandler(fake)({ hook_event_name: "PreToolUse", tool_use_id: "t", tool_name: "bash", tool_input: { command: "rm x" } });
  assert.deepEqual(output, { block: true, reason: "Rejected by the ACP client." });
});

test("lets tools run in default mode and relays streaming, status and turn end", async () => {
  const { fake, log } = host("default", null);
  const handle = createPiHookHandler(fake);
  assert.equal(await handle({ hook_event_name: "PreToolUse", tool_use_id: "t", tool_name: "read", tool_input: { path: "/a" } }), null);
  await handle({ hook_event_name: "MessageDelta", kind: "thought", delta: "hm" });
  await handle({ hook_event_name: "StatusLine", context: { used: 10, size: 100 }, model: { id: "xai/grok", name: "Grok" }, thinking: "high" });
  await handle({ hook_event_name: "TurnEnd" });
  assert.deepEqual(log.streamed, ["thought:hm"]);
  assert.deepEqual(log.statuses, [{ contextUsed: 10, contextSize: 100, modelId: "xai/grok", modelLabel: "Grok", effort: "high" }]);
  assert.equal(log.ended, true);
});
