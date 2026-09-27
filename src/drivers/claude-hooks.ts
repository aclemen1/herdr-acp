import type { ElicitationSchema, PermissionOption } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { elicitationContent } from "../elicitation.ts";
import { modeAllowsTool } from "./claude-modes.ts";
import { toolContent, toolKind, toolLocations, toolTitle } from "./claude-tools.ts";
import type { HookHandler, HookHost } from "./types.ts";

const INTERACTIVE_HOOK_TIMEOUT_S = 3600;
const PLAN_EXIT_OPTIONS: PermissionOption[] = [
  { optionId: "auto", name: "Yes, and use auto mode", kind: "allow_always" },
  { optionId: "bypassPermissions", name: "Yes, and bypass permissions", kind: "allow_always" },
  { optionId: "acceptEdits", name: "Yes, and auto-accept edits", kind: "allow_always" },
  { optionId: "default", name: "Yes, and manually approve edits", kind: "allow_once" },
];
const PLAN_APPROVED_PROMPT = "The user approved your plan. Implement it now.";

export function claudeHookSettings(command: string) {
  const handler = (timeout?: number) => [{ type: "command", command, ...(timeout ? { timeout } : {}) }];
  return {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: handler(INTERACTIVE_HOOK_TIMEOUT_S) }],
      PermissionRequest: [{ matcher: "*", hooks: handler(INTERACTIVE_HOOK_TIMEOUT_S) }],
      MessageDisplay: [{ hooks: handler() }],
      UserPromptSubmit: [{ hooks: handler() }],
    },
  };
}

type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  permission_suggestions?: unknown[] | null;
  permission_mode?: string;
  effort?: { level?: string };
  context_window?: { total_input_tokens?: number; total_output_tokens?: number; context_window_size?: number };
  model?: { id?: string; display_name?: string };
  rate_limits?: Record<string, unknown>;
  message_id?: string;
  index?: number;
  delta?: string;
};

export type Question = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
};

export function createClaudeHookHandler(host: HookHost): HookHandler {
  const announced = new Map<string, string>();
  let lastDelta: { messageId: string; endsWithNewline: boolean } | null = null;

  return async (raw) => {
    const input = raw as HookInput;
    if (input.permission_mode) await host.reportMode(input.permission_mode);
    if (input.hook_event_name !== "StatusLine" && input.effort?.level) await host.reportStatus({ effort: input.effort.level });
    switch (input.hook_event_name) {
      case "StatusLine":
        await host.reportStatus(statusFromInput(input));
        return null;
      case "MessageDisplay": {
        if (typeof input.delta !== "string" || !input.delta) return null;
        const messageId = input.message_id ?? "";
        const continues = lastDelta?.messageId === messageId && (input.index ?? 0) > 0;
        const separator = continues && !lastDelta?.endsWithNewline && !input.delta.startsWith("\n") ? "\n\n" : "";
        lastDelta = { messageId, endsWithNewline: input.delta.endsWith("\n") };
        await host.streamText(separator + input.delta);
        return null;
      }
      case "PreToolUse": {
        const name = input.tool_name ?? "tool";
        const id = input.tool_use_id;
        if (id) {
          announced.set(toolKey(name, input.tool_input), id);
          host.announceToolCall(id);
          const locations = toolLocations(input.tool_input);
          const content = toolContent(name, input.tool_input);
          await host.notify({
            sessionUpdate: "tool_call",
            toolCallId: id,
            title: toolTitle(name, input.tool_input),
            kind: toolKind(name),
            status: "pending",
            rawInput: input.tool_input,
            ...(locations ? { locations } : {}),
            ...(content ? { content } : {}),
          });
        }
        if (name === "AskUserQuestion") return answerQuestions(host, input.tool_input ?? {}, id);
        if (name === "ExitPlanMode") return decideExitPlan(host, input, id);
        return null;
      }
      case "PermissionRequest":
        return decidePermission(host, input, announced.get(toolKey(input.tool_name ?? "tool", input.tool_input)));
      default:
        return null;
    }
  };
}

export function statusFromInput(input: HookInput) {
  const window = input.context_window;
  return {
    ...(window?.context_window_size ? { contextSize: window.context_window_size } : {}),
    ...(window?.total_input_tokens !== undefined
      ? { contextUsed: window.total_input_tokens + (window.total_output_tokens ?? 0) }
      : {}),
    ...(input.model?.id ? { modelId: input.model.id } : {}),
    ...(input.model?.display_name ? { modelLabel: input.model.display_name } : {}),
    ...(input.effort?.level ? { effort: input.effort.level } : {}),
    ...(input.rate_limits ? { rateLimits: input.rate_limits } : {}),
  };
}

function toolKey(name: string, input: unknown): string {
  return `${name}\u0000${JSON.stringify(input ?? null)}`;
}

function permissionOutput(decision: Record<string, unknown>) {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

function setMode(mode: string) {
  return { type: "setMode", mode, destination: "session" };
}

async function decidePermission(host: HookHost, input: HookInput, toolCallId: string | undefined) {
  const name = input.tool_name ?? "tool";
  const toolCall = {
    toolCallId: toolCallId ?? `permission-${randomUUID()}`,
    title: toolTitle(name, input.tool_input),
    kind: toolKind(name),
    status: "pending" as const,
    rawInput: input.tool_input,
  };
  const pending = host.takePendingMode();
  if (pending && modeAllowsTool(pending, name)) {
    await host.reportMode(pending);
    return permissionOutput({ behavior: "allow", updatedPermissions: [setMode(pending)] });
  }
  const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions : [];
  const options: PermissionOption[] = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    ...(suggestions.length > 0 ? [{ optionId: "allow_always", name: "Always allow", kind: "allow_always" as const }] : []),
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
  const choice = await host.requestPermission(toolCall, options);
  if (choice === "allow" || choice === "allow_always") {
    const updates = [...(choice === "allow_always" ? suggestions : []), ...(pending ? [setMode(pending)] : [])];
    if (pending) await host.reportMode(pending);
    return permissionOutput({ behavior: "allow", ...(updates.length > 0 ? { updatedPermissions: updates } : {}) });
  }
  if (pending) host.restorePendingMode(pending);
  if (choice === null) {
    host.markCancelled();
    return permissionOutput({ behavior: "deny", message: "Cancelled by the ACP client.", interrupt: true });
  }
  return permissionOutput({ behavior: "deny", message: "Rejected by the ACP client." });
}

async function decideExitPlan(host: HookHost, input: HookInput, toolCallId: string | undefined) {
  const plan = typeof input.tool_input?.plan === "string" ? input.tool_input.plan : "";
  const choice = await host.requestPermission(
    {
      toolCallId: toolCallId ?? `plan-${randomUUID()}`,
      title: "Ready to code?",
      kind: "switch_mode",
      status: "pending",
      rawInput: input.tool_input,
      ...(plan ? { content: [{ type: "content", content: { type: "text", text: plan } }] } : {}),
    },
    [
      ...PLAN_EXIT_OPTIONS.filter((option) => host.availableModeIds().includes(option.optionId)),
      { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
    ],
  );
  const output = (decision: "allow" | "deny", reason?: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  });
  if (choice && choice !== "plan") {
    host.takePendingMode();
    host.continueWithMode(choice, PLAN_APPROVED_PROMPT);
    if (toolCallId) {
      host.settleToolCall(toolCallId);
      await host.notify({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: `Plan approved (${choice})` } }],
      });
    }
    return {
      continue: false,
      stopReason: "Plan approved in the ACP client.",
      ...output("deny", "The user approved the plan in the ACP client. Claude restarts outside plan mode to implement it."),
    };
  }
  if (choice === null) {
    host.markCancelled();
    return { continue: false, stopReason: "Cancelled by the ACP client." };
  }
  return output("deny", "The user wants to keep planning.");
}

export function questionsSchema(questions: Question[]): ElicitationSchema {
  const properties: ElicitationSchema["properties"] = {};
  questions.forEach((question, index) => {
    const title = question.header ? `${question.header}: ${question.question}` : question.question;
    properties[`q${index}`] = question.multiSelect
      ? { type: "array", title, items: { anyOf: question.options.map(enumOption) } }
      : { type: "string", title, oneOf: question.options.map(enumOption) };
    properties[`q${index}_other`] = { type: "string", title: `${question.header ?? `Question ${index + 1}`}: other answer (optional)` };
  });
  return { type: "object", properties };
}

function enumOption(option: { label: string; description?: string }) {
  return { const: option.label, title: option.description ? `${option.label} — ${option.description}` : option.label };
}

export function answersFromContent(questions: Question[], content: Record<string, unknown>): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const picked = content[`q${index}`];
    const other = typeof content[`q${index}_other`] === "string" ? (content[`q${index}_other`] as string).trim() : "";
    const selected = Array.isArray(picked) ? picked.map(String) : typeof picked === "string" && picked ? [picked] : [];
    const values = question.multiSelect ? [...selected, ...(other ? [other] : [])] : other ? [other] : selected;
    answers[question.question] = values.join(", ");
  });
  return answers;
}

async function answerQuestions(host: HookHost, toolInput: Record<string, unknown>, toolCallId: string | undefined) {
  const questions = (Array.isArray(toolInput.questions) ? toolInput.questions : []) as Question[];
  const allow = (answers: Record<string, string>) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, answers } },
  });
  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
  const cancel = () => {
    host.markCancelled();
    return { continue: false, stopReason: "Cancelled by the ACP client." };
  };

  const response = await host.elicit({
    message: questions.length === 1 ? "Claude has a question" : `Claude has ${questions.length} questions`,
    schema: questionsSchema(questions),
    ...(toolCallId ? { toolCallId } : {}),
  });
  if (response) {
    if (response.action === "accept") return allow(answersFromContent(questions, elicitationContent(response)));
    if (response.action === "cancel") return cancel();
    return deny("The user declined to answer.");
  }

  if (questions.some((question) => question.multiSelect)) {
    return deny("The ACP client cannot display multiple-choice questions. Ask the question in plain text instead.");
  }
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const choice = await host.requestPermission(
      {
        toolCallId: toolCallId ?? `question-${randomUUID()}`,
        title: question.question,
        kind: "other",
        status: "pending",
        content: [
          {
            type: "content",
            content: { type: "text", text: question.options.map((o) => `• ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n") },
          },
        ],
      },
      [
        ...question.options.map((option, index) => ({ optionId: String(index), name: option.label, kind: "allow_once" as const })),
        { optionId: "decline", name: "Decline", kind: "reject_once" },
      ],
    );
    if (choice === null) return cancel();
    const option = question.options[Number(choice)];
    if (choice === "decline" || !option) return deny("The user declined to answer.");
    answers[question.question] = option.label;
  }
  return allow(answers);
}
