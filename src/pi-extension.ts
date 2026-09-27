import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { defaultStateDir, envFilePath, socketPath } from "./hook-bridge.ts";

type Ctx = {
  sessionManager: { getSessionId(): string };
  model?: { provider?: string; id?: string; name?: string; contextWindow?: number };
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
};

type Api = {
  on(event: string, handler: (event: any, ctx: Ctx) => unknown): void;
  getCommands(): { name: string; description?: string }[];
  getThinkingLevel(): string;
};

const DELTA_FLUSH_MS = 50;

export default function herdrAcp(pi: Api): void {
  let sessionId: string | undefined;
  let pending: { kind: "text" | "thought"; delta: string } | null = null;
  let flushTimer: NodeJS.Timeout | null = null;

  const socket = () => process.env.HERDR_ACP_SOCKET ?? (sessionId ? socketPath(defaultStateDir(), sessionId) : undefined);
  const send = (input: Record<string, unknown>) => request(socket(), { ...input, session_id: sessionId });

  const flush = async () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    const chunk = pending;
    pending = null;
    if (chunk) await send({ hook_event_name: "MessageDelta", kind: chunk.kind, delta: chunk.delta });
  };

  const status = (ctx: Ctx) => {
    const usage = ctx.getContextUsage();
    return send({
      hook_event_name: "StatusLine",
      ...(usage ? { context: { used: usage.tokens, size: usage.contextWindow } } : {}),
      ...(ctx.model?.provider && ctx.model.id
        ? { model: { id: `${ctx.model.provider}/${ctx.model.id}`, name: ctx.model.name ?? ctx.model.id } }
        : {}),
      thinking: pi.getThinkingLevel(),
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    await send({ hook_event_name: "SessionStart", commands: pi.getCommands() });
    await status(ctx);
  });

  pi.on("before_agent_start", () => {
    loadEnvFile(process.env.HERDR_ACP_ENV_FILE ?? (sessionId ? envFilePath(defaultStateDir(), sessionId) : undefined));
  });

  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent as { type?: string; delta?: string };
    const kind = update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thought" : null;
    if (!kind || !update.delta) return;
    if (pending && pending.kind !== kind) void flush();
    pending = pending ? { kind, delta: pending.delta + update.delta } : { kind, delta: update.delta };
    flushTimer ??= setTimeout(() => void flush(), DELTA_FLUSH_MS);
  });

  pi.on("tool_call", async (event) => {
    await flush();
    const output = (await send({
      hook_event_name: "PreToolUse",
      tool_use_id: event.toolCallId,
      tool_name: event.toolName,
      tool_input: event.input,
    })) as { block?: boolean; reason?: string; terminate?: boolean } | null;
    return output?.block ? output : undefined;
  });

  pi.on("message_end", (event, ctx) => {
    if ((event.message as { role?: string })?.role === "assistant") return status(ctx);
  });
  pi.on("model_select", (_event, ctx) => status(ctx));
  pi.on("thinking_level_select", (_event, ctx) => status(ctx));

  pi.on("agent_settled", async () => {
    await flush();
    await send({ hook_event_name: "TurnEnd" });
  });
}

export function loadEnvFile(path: string | undefined): void {
  if (!path || !existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line);
    if (match) process.env[match[1]!] = match[2]!.replaceAll("'\\''", "'");
  }
}

function request(path: string | undefined, input: Record<string, unknown>): Promise<unknown> {
  if (!path || !existsSync(path)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const client = connect(path);
    let reply = "";
    client.setEncoding("utf8");
    client.on("connect", () => client.write(`${JSON.stringify({ input })}\n`));
    client.on("data", (chunk: string) => {
      reply += chunk;
    });
    client.on("error", () => resolve(null));
    client.on("close", () => {
      try {
        resolve((JSON.parse(reply) as { output: unknown }).output);
      } catch {
        resolve(null);
      }
    });
  });
}
