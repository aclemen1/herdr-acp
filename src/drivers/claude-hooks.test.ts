import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateElicitationResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { alwaysAllowLabel, answersFromContent, createClaudeHookHandler, type Question, questionsSchema } from "./claude-hooks.ts";
import type { HookHost, StatusReport } from "./types.ts";

type FakeHost = HookHost & {
  updates: SessionUpdate[];
  streamed: string[];
  announced: string[];
  permissions: { title: string; options: string[] }[];
  cancelled: boolean;
  modes: string[];
  pending: string | null;
  continuation: { modeId: string; prompt: string } | null;
  statuses: StatusReport[];
};

function fakeHost(
  opts: { elicit?: CreateElicitationResponse | null; permission?: (string | null)[]; pending?: string } = {},
): FakeHost {
  const choices = [...(opts.permission ?? [])];
  const host: FakeHost = {
    sessionId: "s1",
    updates: [],
    streamed: [],
    announced: [],
    permissions: [],
    cancelled: false,
    modes: [],
    pending: opts.pending ?? null,
    continuation: null,
    statuses: [],
    continueWithMode: (modeId, prompt) => {
      host.continuation = { modeId, prompt };
    },
    availableModeIds: () => ["default", "acceptEdits", "plan", "auto"],
    reportStatus: async (status) => {
      host.statuses.push(status);
    },
    reportMode: async (mode) => {
      host.modes.push(mode);
    },
    takePendingMode: () => {
      const pending = host.pending;
      host.pending = null;
      return pending;
    },
    restorePendingMode: (mode) => {
      host.pending ??= mode;
    },
    notify: async (update) => {
      host.updates.push(update);
    },
    announceToolCall: (id) => {
      host.announced.push(id);
    },
    settleToolCall: () => {},
    streamText: async (text) => {
      host.streamed.push(text);
    },
    requestPermission: async (toolCall, options) => {
      host.permissions.push({ title: toolCall.title ?? "", options: options.map((o) => o.optionId) });
      return choices.shift() ?? null;
    },
    elicit: async () => opts.elicit ?? null,
    markCancelled: () => {
      host.cancelled = true;
    },
  };
  return host;
}

const color: Question = {
  question: "Couleur ?",
  header: "Couleur",
  options: [{ label: "Rouge" }, { label: "Vert", description: "La verte" }],
  multiSelect: false,
};
const fruits: Question = { question: "Fruits ?", options: [{ label: "Pomme" }, { label: "Poire" }], multiSelect: true };
const ask = (questions: Question[]) => ({
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "tu1",
  tool_input: { questions },
});

test("builds an elicitation form with one field per question", () => {
  assert.deepEqual(questionsSchema([color, fruits]), {
    type: "object",
    properties: {
      q0: {
        type: "string",
        title: "Couleur: Couleur ?",
        oneOf: [
          { const: "Rouge", title: "Rouge" },
          { const: "Vert", title: "Vert — La verte" },
        ],
      },
      q0_other: { type: "string", title: "Couleur: other answer (optional)" },
      q1: {
        type: "array",
        title: "Fruits ?",
        items: { anyOf: [{ const: "Pomme", title: "Pomme" }, { const: "Poire", title: "Poire" }] },
      },
      q1_other: { type: "string", title: "Question 2: other answer (optional)" },
    },
  });
});

test("free text overrides a single choice and extends a multiple choice", () => {
  assert.deepEqual(answersFromContent([color, fruits], { q0: "Rouge", q0_other: "Jaune", q1: ["Pomme"], q1_other: "Kiwi" }), {
    "Couleur ?": "Jaune",
    "Fruits ?": "Pomme, Kiwi",
  });
});

test("answers AskUserQuestion through an elicitation form", async () => {
  const host = fakeHost({ elicit: { action: "accept", content: { q0: "Vert", q1: ["Pomme", "Poire"] } } });
  const output = await createClaudeHookHandler(host)(ask([color, fruits]));
  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions: [color, fruits], answers: { "Couleur ?": "Vert", "Fruits ?": "Pomme, Poire" } },
    },
  });
  assert.deepEqual(host.announced, ["tu1"]);
  assert.equal(host.updates[0]?.sessionUpdate, "tool_call");
});

test("stops Claude when the client cancels the form", async () => {
  const host = fakeHost({ elicit: { action: "cancel" } });
  const output = await createClaudeHookHandler(host)(ask([color]));
  assert.deepEqual(output, { continue: false, stopReason: "Cancelled by the ACP client." });
  assert.equal(host.cancelled, true);
});

test("falls back to one permission request per single-choice question", async () => {
  const host = fakeHost({ permission: ["1"] });
  const output = (await createClaudeHookHandler(host)(ask([color]))) as { hookSpecificOutput: { updatedInput: unknown } };
  assert.deepEqual(host.permissions, [{ title: "Couleur ?", options: ["0", "1", "decline"] }]);
  assert.deepEqual((output.hookSpecificOutput.updatedInput as { answers: unknown }).answers, { "Couleur ?": "Vert" });
});

test("denies multiple choice questions when the client has no forms", async () => {
  const output = (await createClaudeHookHandler(fakeHost())(ask([fruits]))) as {
    hookSpecificOutput: { permissionDecision: string };
  };
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("maps permission requests to the announced tool call", async () => {
  const host = fakeHost({ permission: ["reject"] });
  const handle = createClaudeHookHandler(host);
  const toolInput = { command: "touch x", description: "Create x" };
  assert.equal(await handle({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu7", tool_input: toolInput }), null);
  const output = await handle({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: toolInput });
  assert.deepEqual(output, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Rejected by the ACP client." } },
  });
  assert.deepEqual(host.permissions, [{ title: "Create x", options: ["allow", "reject"] }]);
});

test("offers always-allow when Claude suggests permission rules", async () => {
  const host = fakeHost({ permission: ["allow_always"] });
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }];
  const output = await createClaudeHookHandler(host)({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    permission_suggestions: suggestions,
  });
  assert.deepEqual(output, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: suggestions } },
  });
});

test("streams message deltas and separates paragraphs", async () => {
  const host = fakeHost();
  const handle = createClaudeHookHandler(host);
  await handle({ hook_event_name: "MessageDisplay", message_id: "m", index: 0, delta: "Un." });
  await handle({ hook_event_name: "MessageDisplay", message_id: "m", index: 1, delta: "Deux." });
  await handle({ hook_event_name: "MessageDisplay", message_id: "n", index: 0, delta: "Trois." });
  assert.deepEqual(host.streamed, ["Un.", "\n\nDeux.", "Trois."]);
});

test("reports the live permission mode from hook inputs", async () => {
  const host = fakeHost();
  await createClaudeHookHandler(host)({ hook_event_name: "UserPromptSubmit", permission_mode: "plan" });
  assert.deepEqual(host.modes, ["plan"]);
});

test("applies a pending accept-edits mode to an edit without asking", async () => {
  const host = fakeHost({ pending: "acceptEdits" });
  const output = await createClaudeHookHandler(host)({ hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: {} });
  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] },
    },
  });
  assert.deepEqual(host.permissions, []);
  assert.deepEqual(host.modes, ["acceptEdits"]);
});

test("keeps a pending mode when the user rejects the tool call", async () => {
  const host = fakeHost({ pending: "default", permission: ["reject"] });
  await createClaudeHookHandler(host)({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } });
  assert.equal(host.pending, "default");
});

test("turns a plan approval into a restart in the chosen mode", async () => {
  const host = fakeHost({ permission: ["acceptEdits"] });
  const output = (await createClaudeHookHandler(host)({
    hook_event_name: "PreToolUse",
    tool_name: "ExitPlanMode",
    tool_use_id: "tp1",
    tool_input: { plan: "1. Do it" },
  })) as { continue: boolean; hookSpecificOutput: { permissionDecision: string } };
  assert.deepEqual(host.permissions, [{ title: "Ready to code?", options: ["auto", "acceptEdits", "default", "plan"] }]);
  assert.equal(output.continue, false);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(host.continuation, { modeId: "acceptEdits", prompt: "The user approved your plan. Implement it now." });
  assert.equal(host.updates.at(-1)?.sessionUpdate, "tool_call_update");
});

test("keeps planning when the user rejects the plan", async () => {
  const host = fakeHost({ permission: ["plan"] });
  const output = (await createClaudeHookHandler(host)({
    hook_event_name: "PreToolUse",
    tool_name: "ExitPlanMode",
    tool_use_id: "tp2",
    tool_input: { plan: "1. Do it" },
  })) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(host.continuation, null);
});

test("reports context, model, effort and quotas from the status line", async () => {
  const host = fakeHost();
  await createClaudeHookHandler(host)({
    hook_event_name: "StatusLine",
    context_window: { total_input_tokens: 1000, total_output_tokens: 50, context_window_size: 200000 },
    model: { id: "claude-x", display_name: "X" },
    effort: { level: "high" },
    rate_limits: { five_hour: { used_percentage: 12 } },
  });
  assert.deepEqual(host.statuses, [
    {
      contextSize: 200000,
      contextUsed: 1050,
      modelId: "claude-x",
      modelLabel: "X",
      effort: "high",
      rateLimits: { five_hour: { used_percentage: 12 } },
    },
  ]);
});

test("announces edits with a diff", async () => {
  const host = fakeHost();
  await createClaudeHookHandler(host)({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: "te1",
    tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
  });
  const update = host.updates[0] as { content?: unknown };
  assert.deepEqual(update.content, [{ type: "diff", path: "/a.ts", oldText: "x", newText: "y" }]);
});

test("labels always-allow options with the suggested rules", () => {
  assert.equal(
    alwaysAllowLabel([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }, { toolName: "Read" }] }]),
    "Always allow Bash(npm test:*), Read",
  );
  assert.equal(alwaysAllowLabel([{ type: "setMode" }]), "Always allow");
});
