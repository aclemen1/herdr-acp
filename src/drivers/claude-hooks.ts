import type { ElicitationSchema, PermissionOption } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { elicitationContent } from "../elicitation.ts";
import { toolKind, toolLocations, toolTitle } from "./claude-tools.ts";
import type { HookHandler, HookHost } from "./types.ts";

const INTERACTIVE_HOOK_TIMEOUT_S = 3600;

export function claudeHookSettings(command: string) {
  const handler = (timeout?: number) => [{ type: "command", command, ...(timeout ? { timeout } : {}) }];
  return {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: handler(INTERACTIVE_HOOK_TIMEOUT_S) }],
      PermissionRequest: [{ matcher: "*", hooks: handler(INTERACTIVE_HOOK_TIMEOUT_S) }],
      MessageDisplay: [{ hooks: handler() }],
    },
  };
}

type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  permission_suggestions?: unknown[] | null;
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
    switch (input.hook_event_name) {
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
          await host.notify({
            sessionUpdate: "tool_call",
            toolCallId: id,
            title: toolTitle(name, input.tool_input),
            kind: toolKind(name),
            status: "pending",
            rawInput: input.tool_input,
            ...(locations ? { locations } : {}),
          });
        }
        if (name === "AskUserQuestion") return answerQuestions(host, input.tool_input ?? {}, id);
        return null;
      }
      case "PermissionRequest":
        return decidePermission(host, input, announced.get(toolKey(input.tool_name ?? "tool", input.tool_input)));
      default:
        return null;
    }
  };
}

function toolKey(name: string, input: unknown): string {
  return `${name}\u0000${JSON.stringify(input ?? null)}`;
}

async function decidePermission(host: HookHost, input: HookInput, toolCallId: string | undefined) {
  const name = input.tool_name ?? "tool";
  const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions : [];
  const options: PermissionOption[] = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    ...(suggestions.length > 0 ? [{ optionId: "allow_always", name: "Always allow", kind: "allow_always" as const }] : []),
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
  const choice = await host.requestPermission(
    {
      toolCallId: toolCallId ?? `permission-${randomUUID()}`,
      title: toolTitle(name, input.tool_input),
      kind: toolKind(name),
      status: "pending",
      rawInput: input.tool_input,
    },
    options,
  );
  const output = (decision: Record<string, unknown>) => ({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  });
  if (choice === null) {
    host.markCancelled();
    return output({ behavior: "deny", message: "Cancelled by the ACP client.", interrupt: true });
  }
  if (choice === "allow") return output({ behavior: "allow" });
  if (choice === "allow_always") return output({ behavior: "allow", updatedPermissions: suggestions });
  return output({ behavior: "deny", message: "Rejected by the ACP client." });
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
