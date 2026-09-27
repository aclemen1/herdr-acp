import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import * as acp from "@agentclientprotocol/sdk";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string", default: process.cwd() },
    "herdr-session": { type: "string" },
    workspace: { type: "string", default: "acp-smoke" },
    load: { type: "string" },
    close: { type: "boolean", default: false },
    deny: { type: "boolean", default: false },
    ask: { type: "string" },
    "cancel-after": { type: "string" },
    "no-forms": { type: "boolean", default: false },
    "trust-folders": { type: "boolean", default: false },
    "set-mode": { type: "string" },
    config: { type: "string", multiple: true },
    resume: { type: "string" },
    fork: { type: "string" },
    image: { type: "string" },
    list: { type: "boolean", default: false },
  },
});

const prompts = positionals.length > 0 ? positionals : ["Exécute la commande pwd avec l'outil Bash, puis réponds en une phrase."];

const args = ["src/index.ts", "--workspace", values.workspace!];
if (values["herdr-session"]) args.push("--herdr-session", values["herdr-session"]);
if (values["trust-folders"]) args.push("--trust-folders");
if (values.ask) args.push("--", "--settings", JSON.stringify({ permissions: { ask: [values.ask] } }));
const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });

const summarize = (options: acp.SessionConfigOption[] | null | undefined) =>
  Object.fromEntries((options ?? []).map((option) => [option.id, option.type === "select" ? option.currentValue : option.currentValue]));

const log = (label: string, detail: unknown = "") =>
  process.stdout.write(`${label} ${typeof detail === "string" ? detail : JSON.stringify(detail)}\n`);

await acp
  .client({ name: "herdr-acp-smoke" })
  .onRequest("session/request_permission", ({ params }) => {
    const optionId = values.deny ? "reject" : "allow";
    const chosen = params.options.some((option) => option.optionId === optionId)
      ? optionId
      : params.options[values.deny ? params.options.length - 1 : 1]!.optionId;
    log("PERMISSION", { title: params.toolCall.title, options: params.options.map((o) => o.name), answer: chosen });
    return { outcome: { outcome: "selected", optionId: chosen } };
  })
  .onRequest("elicitation/create", ({ params }) => {
    if (!("requestedSchema" in params)) return { action: "decline" };
    const requested = params.requestedSchema as acp.ElicitationSchema;
    const content: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(requested.properties ?? {})) {
      const schema = property as { type: string; oneOf?: { const: string }[]; items?: { anyOf?: { const: string }[] } };
      if (schema.type === "boolean") content[key] = !values.deny;
      else if (schema.type === "string" && schema.oneOf) content[key] = schema.oneOf[1]?.const ?? schema.oneOf[0]?.const;
      else if (schema.type === "array") content[key] = (schema.items?.anyOf ?? []).map((option) => option.const);
    }
    log("ELICITATION", { message: params.message, fields: Object.keys(requested.properties ?? {}), content });
    return { action: "accept", content };
  })
  .onNotification("session/update", ({ params }) => {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "user_message_chunk":
        log(update.sessionUpdate, update.content.type === "text" ? update.content.text.slice(0, 200) : update.content.type);
        break;
      case "tool_call":
        log("tool_call", {
          id: update.toolCallId,
          title: update.title,
          kind: update.kind,
          content: update.content?.map((item) => item.type),
        });
        break;
      case "tool_call_update":
        log("tool_call_update", { id: update.toolCallId, status: update.status });
        break;
      case "current_mode_update":
        log("current_mode_update", update.currentModeId);
        break;
      case "available_commands_update":
        log("available_commands_update", update.availableCommands.map((command) => command.name).slice(0, 8));
        break;
      case "usage_update":
        log("usage_update", { used: update.used, size: update.size });
        break;
      case "config_option_update":
        log("config_option_update", summarize(update.configOptions));
        break;
      default:
        log(update.sessionUpdate);
    }
  })
  .connectWith(
    acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    async (ctx) => {
      const init = await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: values["no-forms"] ? {} : { elicitation: { form: {} } },
      });
      log("INITIALIZE", init.agentInfo);
      let sessionId: string;
      if (values.fork) {
        const forked = await ctx.request("session/fork", { sessionId: values.fork, cwd: values.cwd!, mcpServers: [] });
        sessionId = forked.sessionId;
        log("FORKED", { from: values.fork, sessionId });
      } else if (values.resume) {
        const resumed = await ctx.request("session/resume", { sessionId: values.resume, cwd: values.cwd!, mcpServers: [] });
        sessionId = values.resume;
        log("RESUMED", summarize(resumed.configOptions));
      } else if (values.load) {
        const loaded = await ctx.request("session/load", { sessionId: values.load, cwd: values.cwd!, mcpServers: [] });
        sessionId = values.load;
        log("LOADED", loaded);
      } else {
        const created = await ctx.request("session/new", { cwd: values.cwd!, mcpServers: [] });
        sessionId = created.sessionId;
        log("NEW", {
          sessionId: created.sessionId,
          modes: created.modes?.availableModes.map((m) => m.id),
          config: summarize(created.configOptions),
        });
      }
      if (values["set-mode"]) {
        const started = Date.now();
        await ctx.request("session/set_mode", { sessionId, modeId: values["set-mode"] });
        log("SET_MODE", { modeId: values["set-mode"], ms: Date.now() - started });
      }
      for (const entry of values.config ?? []) {
        const [configId, value] = entry.split("=") as [string, string];
        const started = Date.now();
        const result = await ctx.request("session/set_config_option", { sessionId, configId, value });
        log("SET_CONFIG", { configId, value, ms: Date.now() - started, config: summarize(result.configOptions) });
      }
      for (const text of prompts) {
        log("PROMPT", text);
        const started = Date.now();
        if (values["cancel-after"]) {
          setTimeout(() => {
            log("CANCEL");
            void ctx.notify("session/cancel", { sessionId });
          }, Number(values["cancel-after"]));
        }
        const prompt: acp.ContentBlock[] = [{ type: "text", text }];
        if (values.image) {
          prompt.push({ type: "image", mimeType: "image/png", data: readFileSync(values.image).toString("base64") });
        }
        const response = await ctx.request("session/prompt", { sessionId, prompt });
        log("RESPONSE", { ...response, ms: Date.now() - started });
      }
      const listed = await ctx.request("session/list", { cwd: values.cwd! });
      log(
        "LIST",
        values.list
          ? listed.sessions.slice(0, 5).map((session) => ({ id: session.sessionId.slice(0, 8), title: session.title, updatedAt: session.updatedAt }))
          : listed.sessions.length,
      );
      if (values.close) await ctx.request("session/close", { sessionId });
    },
  );

child.kill();
