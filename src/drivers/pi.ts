import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SessionConfigOption, SessionMode, SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { GLOBAL_HOOK_MARKER } from "../hook-bridge.ts";
import { argValue, withoutArg } from "./claude-config.ts";
import type {
  Driver,
  DriverEvent,
  HookHandler,
  HookHost,
  LaunchInput,
  SessionSettings,
  TokenUsage,
  TranscriptParser,
} from "./types.ts";

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EDIT_TOOLS = new Set(["edit", "write"]);

const MODES: SessionMode[] = [
  { id: "default", name: "Auto", description: "Run tools without asking" },
  { id: "ask", name: "Ask", description: "Approve each tool call" },
];

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_SESSION_DIR ?? join(piAgentDir(env), "sessions");
}

export function encodePiProjectDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function extensionPath(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../pi-extension.ts" : "../pi-extension.js", import.meta.url));
}

function globalExtensionFile(): string {
  return join(piAgentDir(), "extensions", "herdr-acp.js");
}

async function hasGlobalExtension(): Promise<boolean> {
  return (await readFile(globalExtensionFile(), "utf8").catch(() => "")).includes(GLOBAL_HOOK_MARKER);
}

async function readPiSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(piAgentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

let modelCatalog: Promise<{ provider: string; id: string }[]> | null = null;

function listModels(): Promise<{ provider: string; id: string }[]> {
  modelCatalog ??= new Promise((resolve) => {
    execFile("pi", ["--list-models"], { timeout: 30_000 }, (_error, stdout) => {
      const models = stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols.length >= 2 && cols[0] && cols[1])
        .map(([provider, id]) => ({ provider: provider!, id: id! }));
      resolve(models);
    });
  });
  return modelCatalog;
}

async function findSessionFile(sessionId: string, cwd?: string): Promise<string | null> {
  const root = sessionsDir();
  const dirs = cwd ? [encodePiProjectDir(await realpath(cwd).catch(() => cwd))] : [];
  const all = await readdir(root).catch(() => [] as string[]);
  for (const dir of [...dirs, ...all.filter((name) => !dirs.includes(name))]) {
    const names = await readdir(join(root, dir)).catch(() => [] as string[]);
    const match = names.find((name) => name.endsWith(`_${sessionId}.jsonl`));
    if (match) return join(root, dir, match);
  }
  return null;
}

export class PiDriver implements Driver {
  readonly kind = "pi";
  readonly title = "Pi";
  readonly acceptTrustKeys: string[] = [];
  readonly exitCommand = "/quit";
  readonly modeRequiresRestart = false;
  readonly extensions = {};
  readonly envAcknowledged = false;
  readonly protectedEnv =
    /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|XAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY|OPENROUTER_API_KEY|DEEPSEEK_API_KEY|CLAUDECODE|CLAUDE_CODE_\w*|CLAUDE_PID|CLAUDE_EFFORT)$/;

  newSessionId(): string {
    return randomUUID();
  }

  sessionIdFromRef(ref: { kind: string; value: string }): string | null {
    if (ref.kind === "id") return ref.value;
    const match = /_([A-Za-z0-9._-]+)\.jsonl$/.exec(basename(ref.value));
    return match ? match[1]! : null;
  }

  async launchArgs(input: LaunchInput): Promise<string[]> {
    const args = input.forkFrom ? ["--fork", input.forkFrom, "--session-id", input.sessionId] : ["--session-id", input.sessionId];
    if (!(await hasGlobalExtension())) args.push("--extension", extensionPath());
    if (input.trustApproved) args.push("--approve");
    let tail = input.extraArgs;
    if (input.model) tail = [...withoutArg(tail, "--model"), ...(input.model === "default" ? [] : ["--model", input.model])];
    if (input.effort) tail = [...withoutArg(tail, "--thinking"), ...(input.effort === "default" ? [] : ["--thinking", input.effort])];
    return [...args, ...tail];
  }

  async transcriptPath(input: { sessionId: string; cwd: string; ref: { kind: string; value: string } | null }) {
    if (input.ref?.kind === "path") return input.ref.value;
    const found = await findSessionFile(input.sessionId, input.cwd);
    if (found) return found;
    const resolved = await realpath(input.cwd).catch(() => input.cwd);
    return join(sessionsDir(), encodePiProjectDir(resolved), `pending_${input.sessionId}.jsonl`);
  }

  async transcriptExists(sessionId: string): Promise<boolean> {
    return (await findSessionFile(sessionId)) !== null;
  }

  async listTranscripts(cwd: string) {
    const resolved = await realpath(cwd).catch(() => cwd);
    const dir = join(sessionsDir(), encodePiProjectDir(resolved));
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"));
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path);
        return {
          sessionId: this.sessionIdFromRef({ kind: "path", value: path }) ?? name,
          title: await piTitle(path),
          updatedAt: info.mtime,
        };
      }),
    );
    return entries
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((entry) => ({ ...entry, updatedAt: entry.updatedAt.toISOString() }));
  }

  createParser(): TranscriptParser {
    return new PiTranscriptParser();
  }

  createHookHandler(host: HookHost): HookHandler {
    return createPiHookHandler(host);
  }

  async isFolderTrusted(cwd: string): Promise<boolean> {
    const exists = (path: string) => access(path).then(() => true, () => false);
    const hasResources = (await exists(join(cwd, ".pi"))) || (await exists(join(cwd, ".agents", "skills")));
    if (!hasResources) return true;
    const trust = JSON.parse(await readFile(join(piAgentDir(), "trust.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
    const resolved = await realpath(cwd).catch(() => cwd);
    return trust[resolved] === true || trust[cwd] === true;
  }

  async installGlobalHooks(): Promise<string> {
    const path = globalExtensionFile();
    await mkdir(join(piAgentDir(), "extensions"), { recursive: true });
    const target = pathToFileURL(extensionPath().replace(/\.ts$/, ".js")).href;
    await writeFile(path, `// ${GLOBAL_HOOK_MARKER}\nexport { default } from ${JSON.stringify(target)};\n`);
    return path;
  }

  async uninstallGlobalHooks(): Promise<string> {
    const path = globalExtensionFile();
    if (await hasGlobalExtension()) await rm(path);
    return path;
  }

  availableModes(): SessionMode[] {
    return MODES;
  }

  async initialSettings(extraArgs: string[]): Promise<SessionSettings> {
    const settings = await readPiSettings();
    const configured =
      typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : "default";
    const thinking = typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "default";
    cachedModels = await listModels();
    return {
      mode: "default",
      model: argValue(extraArgs, "--model") ?? configured,
      effort: argValue(extraArgs, "--thinking") ?? thinking,
    };
  }

  configOptions(settings: SessionSettings, modes: SessionMode[], modelLabel: string | null): SessionConfigOption[] {
    return piConfigOptions(settings, modes, modelLabel, cachedModels);
  }

  replayOrder(records: unknown[]): unknown[] {
    return activeBranch(records);
  }
}

let cachedModels: { provider: string; id: string }[] = [];

export function piConfigOptions(
  settings: SessionSettings,
  modes: SessionMode[],
  modelLabel: string | null,
  models: { provider: string; id: string }[],
): SessionConfigOption[] {
  const groups = new Map<string, { value: string; name: string }[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push({ value: `${model.provider}/${model.id}`, name: model.id });
    groups.set(model.provider, list);
  }
  const known = models.some((model) => `${model.provider}/${model.id}` === settings.model);
  const current = settings.model === "default" || known ? [] : [{ value: settings.model, name: modelLabel ?? settings.model }];
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: settings.mode,
      options: modes.map((mode) => ({ value: mode.id, name: mode.name })),
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: settings.model,
      options: [
        { group: "default", name: "Default", options: [{ value: "default", name: "Default" }, ...current] },
        ...[...groups].map(([provider, options]) => ({ group: provider, name: provider, options })),
      ],
    },
    {
      id: "effort",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: settings.effort ?? "default",
      options: [{ value: "default", name: "Default" }, ...THINKING_LEVELS.map((level) => ({ value: level, name: level }))],
    },
  ];
}

type Entry = { type?: string; id?: string; parentId?: string | null; timestamp?: string; name?: string; message?: PiMessage };
type PiBlock = Record<string, unknown> & { type?: string };
type PiMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  responseId?: string;
  usage?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export function activeBranch(records: unknown[]): unknown[] {
  const entries = records as Entry[];
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
  const leaf = [...entries].reverse().find((entry) => entry.id && entry.type !== "session");
  if (!leaf) return records;
  const chain: Entry[] = [];
  for (let entry: Entry | undefined = leaf; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    chain.unshift(entry);
    if (chain.length > entries.length) break;
  }
  return chain;
}

async function piTitle(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => "");
  let title: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"session_info"') && !(title === null && line.includes('"role":"user"'))) continue;
    try {
      const entry = JSON.parse(line) as Entry;
      if (entry.type === "session_info" && entry.name) title = entry.name;
      else if (title === null && entry.message?.role === "user") title = firstText(entry.message.content).slice(0, 80) || null;
    } catch {}
  }
  return title;
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  return asBlocks(content)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
}

function asBlocks(content: unknown): PiBlock[] {
  return Array.isArray(content) ? (content.filter((block) => block && typeof block === "object") as PiBlock[]) : [];
}

export function piToolKind(name: string): ToolKind {
  switch (name) {
    case "read":
      return "read";
    case "edit":
    case "write":
      return "edit";
    case "bash":
    case "powershell":
      return "execute";
    case "grep":
    case "find":
    case "ls":
      return "search";
    default:
      return /fetch|search|web/i.test(name) ? "fetch" : "other";
  }
}

export function piToolTitle(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  if (name === "bash" || name === "powershell") return str("command") ?? name;
  if (str("path")) return `${name} ${str("path")}`;
  if (str("pattern")) return `${name} ${str("pattern")}`;
  if (str("url")) return `${name} ${str("url")}`;
  return name;
}

export function piToolContent(name: string, input: unknown): ToolCallContent[] | undefined {
  const args = (input ?? {}) as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path : undefined;
  if (!path) return undefined;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  if (name === "write") return [{ type: "diff", path, oldText: null, newText: str(args.content) }];
  if (name === "edit" && Array.isArray(args.edits)) {
    return (args.edits as Record<string, unknown>[]).map((edit) => ({
      type: "diff" as const,
      path,
      oldText: str(edit.oldText),
      newText: str(edit.newText),
    }));
  }
  return undefined;
}

function piToolLocations(input: unknown): { path: string }[] | undefined {
  const path = (input as Record<string, unknown> | null)?.path;
  return typeof path === "string" ? [{ path }] : undefined;
}

export class PiTranscriptParser implements TranscriptParser {
  private readonly openToolCalls = new Map<string, string>();
  private readonly announced = new Set<string>();
  private readonly settled = new Set<string>();

  markAnnounced(toolCallId: string): void {
    this.announced.add(toolCallId);
  }

  markSettled(toolCallId: string): void {
    this.settled.add(toolCallId);
  }

  parse(raw: unknown, options: { replay: boolean; since?: number }): DriverEvent[] {
    const entry = raw as Entry;
    if (!entry || entry.type !== "message" || !entry.message) return [];
    if (options.since !== undefined && entry.timestamp && Date.parse(entry.timestamp) < options.since) return [];
    const message = entry.message;
    if (message.role === "user") {
      const text = firstText(message.content);
      return options.replay && text ? [update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } })] : [];
    }
    if (message.role === "assistant") return this.parseAssistant(entry.id ?? "", message);
    if (message.role === "toolResult" && message.toolCallId) return this.parseToolResult(message, options.replay);
    return [];
  }

  private parseAssistant(entryId: string, message: PiMessage): DriverEvent[] {
    const events: DriverEvent[] = [];
    for (const block of asBlocks(message.content)) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        events.push(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } }));
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        events.push(update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } }));
      } else if (block.type === "toolCall" && typeof block.id === "string") {
        const name = String(block.name ?? "tool");
        this.openToolCalls.set(block.id, name);
        const locations = piToolLocations(block.arguments);
        const content = piToolContent(name, block.arguments);
        const fields = {
          toolCallId: block.id,
          title: piToolTitle(name, block.arguments),
          kind: piToolKind(name),
          status: "in_progress" as const,
          rawInput: block.arguments,
          ...(locations ? { locations } : {}),
          ...(content ? { content } : {}),
        };
        events.push(
          update(this.announced.has(block.id) ? { sessionUpdate: "tool_call_update", ...fields } : { sessionUpdate: "tool_call", ...fields }),
        );
      }
    }
    if (message.usage) events.push({ type: "usage", messageId: message.responseId ?? entryId, usage: piUsage(message.usage) });
    if (message.stopReason === "length") events.push({ type: "stop_reason", stopReason: "max_tokens" });
    return events;
  }

  private parseToolResult(message: PiMessage, replay: boolean): DriverEvent[] {
    const id = message.toolCallId!;
    const name = this.openToolCalls.get(id) ?? message.toolName;
    const wasOpen = this.openToolCalls.delete(id);
    if ((!wasOpen || this.settled.delete(id)) && !replay) return [];
    const keepsDiff = name !== undefined && EDIT_TOOLS.has(name) && !message.isError;
    const text = keepsDiff ? "" : truncate(firstText(message.content));
    return [
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: message.isError ? "failed" : "completed",
        ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
      }),
    ];
  }
}

function piUsage(usage: Record<string, unknown>): TokenUsage {
  const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return {
    inputTokens: num("input"),
    outputTokens: num("output"),
    cachedReadTokens: num("cacheRead"),
    cachedWriteTokens: num("cacheWrite"),
    thoughtTokens: num("reasoning"),
  };
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… [truncated]` : text;
}

function update(value: SessionUpdate): DriverEvent {
  return { type: "update", update: value };
}

type PiHookInput = {
  hook_event_name?: string;
  kind?: string;
  delta?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  commands?: { name: string; description?: string }[];
  context?: { used?: number | null; size?: number };
  model?: { id?: string; name?: string };
  thinking?: string;
};

export function createPiHookHandler(host: HookHost): HookHandler {
  return async (raw) => {
    const input = raw as PiHookInput;
    switch (input.hook_event_name) {
      case "SessionStart":
        host.envApplied();
        if (input.commands) {
          await host.notify({
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "compact", description: "Summarize the conversation to free context" },
              ...input.commands.map((command) => ({ name: command.name, description: command.description ?? command.name })),
            ],
          });
        }
        return null;
      case "MessageDelta":
        if (input.delta) await host.streamText(input.delta, input.kind === "thought" ? "thought" : "message");
        return null;
      case "StatusLine":
        await host.reportStatus({
          ...(typeof input.context?.used === "number" && input.context.size
            ? { contextUsed: input.context.used, contextSize: input.context.size }
            : {}),
          ...(input.model?.id ? { modelId: input.model.id } : {}),
          ...(input.model?.name ? { modelLabel: input.model.name } : {}),
          ...(input.thinking ? { effort: input.thinking } : {}),
        });
        return null;
      case "TurnEnd":
        host.endTurn();
        return null;
      case "PreToolUse":
        return decidePiTool(host, input);
      default:
        return null;
    }
  };
}

async function decidePiTool(host: HookHost, input: PiHookInput) {
  const name = input.tool_name ?? "tool";
  const id = input.tool_use_id ?? `pi-${randomUUID()}`;
  const locations = piToolLocations(input.tool_input);
  const content = piToolContent(name, input.tool_input);
  host.announceToolCall(id);
  const toolCall = {
    toolCallId: id,
    title: piToolTitle(name, input.tool_input),
    kind: piToolKind(name),
    status: "pending" as const,
    rawInput: input.tool_input,
    ...(locations ? { locations } : {}),
    ...(content ? { content } : {}),
  };
  await host.notify({ sessionUpdate: "tool_call", ...toolCall });
  if (host.currentMode() !== "ask" || host.interaction() === "native") return null;
  const choice = await host.requestPermission(toolCall, [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ]);
  if (choice === "allow") return null;
  if (choice === null) {
    host.markCancelled();
    return { block: true, reason: "Cancelled by the ACP client.", terminate: true };
  }
  return { block: true, reason: "Rejected by the ACP client." };
}
