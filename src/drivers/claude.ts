import { randomUUID } from "node:crypto";
import { access, mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer, PlanEntry, SessionMode, SessionUpdate } from "@agentclientprotocol/sdk";
import { argValue, claudeConfigOptions, claudeInitialModel, readUserSettings, withoutArg } from "./claude-config.ts";
import { claudeHookSettings, createClaudeHookHandler } from "./claude-hooks.ts";
import { claudeInitialMode, claudeModes } from "./claude-modes.ts";
import { claudeUserSettingsPath, hasGlobalHerdrAcpHooks, installGlobalHooks, uninstallGlobalHooks } from "./claude-settings.ts";
import { toolContent, toolKind, toolLocations, toolTitle } from "./claude-tools.ts";
import { isClaudeFolderTrusted } from "./claude-trust.ts";
import type { Driver, DriverEvent, HookHost, LaunchInput, SessionSettings, TokenUsage, TranscriptParser } from "./types.ts";

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

export class ClaudeDriver implements Driver {
  readonly kind = "claude";
  readonly title = "Claude Code";
  readonly acceptTrustKeys = ["down", "enter"];

  newSessionId(): string {
    return randomUUID();
  }

  async launchArgs(input: LaunchInput): Promise<string[]> {
    const args = input.resume ? ["--resume", input.sessionId] : ["--session-id", input.sessionId];
    if (input.mcpServers.length > 0) {
      const path = join(input.stateDir, `${input.sessionId}.mcp.json`);
      await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(toClaudeMcpConfig(input.mcpServers), null, 2), { mode: 0o600 });
      args.push("--mcp-config", path);
    }
    const { settings, rest } = await extractSettings(input.extraArgs);
    const original = (settings.statusLine ?? (await readUserSettings()).statusLine) as StatusLine | undefined;
    const statusLine: StatusLine = {
      ...(original ?? {}),
      type: "command",
      command: original?.command
        ? `${input.statusLineCommand} ${Buffer.from(original.command).toString("base64url")}`
        : input.statusLineCommand,
    };
    const hooks = (await hasGlobalHerdrAcpHooks()) ? {} : claudeHookSettings(input.hookCommand);
    args.push("--settings", JSON.stringify(mergeSettings({ ...settings, statusLine }, hooks)));

    let tail = rest;
    if (input.mode) tail = [...withoutArg(tail, "--permission-mode"), "--permission-mode", input.mode];
    const model = input.model ?? (argValue(tail, "--model") ? undefined : process.env.ANTHROPIC_MODEL);
    if (model) tail = [...withoutArg(tail, "--model"), ...(model === "default" ? [] : ["--model", model])];
    if (input.effort) tail = [...withoutArg(tail, "--effort"), ...(input.effort === "default" ? [] : ["--effort", input.effort])];
    if (!input.clientCanElicit) tail = [...tail, "--disallowedTools", "AskUserQuestion"];
    return [...args, ...tail];
  }

  readonly exitCommand = "/exit";
  readonly protectedEnv = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_\w*|CLAUDE_PID|CLAUDE_EFFORT)$/;

  availableModes(extraArgs: string[]) {
    return claudeModes(extraArgs);
  }

  async initialSettings(extraArgs: string[]): Promise<SessionSettings> {
    return {
      mode: await claudeInitialMode(extraArgs),
      model: await claudeInitialModel(extraArgs),
      effort: argValue(extraArgs, "--effort") ?? null,
    };
  }

  configOptions(settings: SessionSettings, modes: SessionMode[], modelLabel: string | null) {
    return claudeConfigOptions(settings, modes, modelLabel);
  }

  async listTranscripts(cwd: string) {
    const resolved = await realpath(cwd).catch(() => cwd);
    const dir = join(projectsDir(), encodeProjectDir(resolved));
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"));
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path);
        return { sessionId: name.slice(0, -".jsonl".length), title: await lastTitle(path, info.size), updatedAt: info.mtime };
      }),
    );
    return entries
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((entry) => ({ ...entry, updatedAt: entry.updatedAt.toISOString() }));
  }

  async installGlobalHooks(command: string): Promise<string> {
    const path = claudeUserSettingsPath();
    await installGlobalHooks(command, path);
    return path;
  }

  async uninstallGlobalHooks(): Promise<string> {
    const path = claudeUserSettingsPath();
    await uninstallGlobalHooks(path);
    return path;
  }

  async transcriptPath(input: { sessionId: string; cwd: string; ref: { kind: string; value: string } | null }) {
    if (input.ref?.kind === "path") return input.ref.value;
    const id = input.ref?.kind === "id" ? input.ref.value : input.sessionId;
    const found = await findTranscript(id);
    if (found) return found;
    const resolved = await realpath(input.cwd).catch(() => input.cwd);
    return join(projectsDir(), encodeProjectDir(resolved), `${id}.jsonl`);
  }

  async transcriptExists(sessionId: string): Promise<boolean> {
    return (await findTranscript(sessionId)) !== null;
  }

  createParser(): TranscriptParser {
    return new ClaudeTranscriptParser();
  }

  createHookHandler(host: HookHost) {
    return createClaudeHookHandler(host);
  }

  isFolderTrusted(cwd: string): Promise<boolean> {
    return isClaudeFolderTrusted(cwd);
  }
}

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown[]> };
type StatusLine = { type: "command"; command: string; padding?: number };

const TITLE_SCAN_BYTES = 256 * 1024;

async function lastTitle(path: string, size: number): Promise<string | null> {
  const length = Math.min(size, TITLE_SCAN_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const record = JSON.parse(line) as { type?: string; aiTitle?: string };
        if (record.type === "ai-title" && record.aiTitle) return record.aiTitle;
      } catch {}
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function extractSettings(extraArgs: string[]): Promise<{ settings: Settings; rest: string[] }> {
  const rest: string[] = [];
  let settings: Settings = {};
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    const inline = arg.startsWith("--settings=") ? arg.slice("--settings=".length) : undefined;
    if (arg !== "--settings" && inline === undefined) {
      rest.push(arg);
      continue;
    }
    const value = inline ?? extraArgs[++i] ?? "";
    const text = value.trim().startsWith("{") ? value : await readFile(value, "utf8");
    settings = mergeSettings(settings, JSON.parse(text) as Settings);
  }
  return { settings, rest };
}

export function mergeSettings(base: Settings, extra: Settings): Settings {
  const hooks: Record<string, unknown[]> = { ...(base.hooks ?? {}) };
  for (const [event, matchers] of Object.entries(extra.hooks ?? {})) hooks[event] = [...(hooks[event] ?? []), ...matchers];
  return { ...base, ...extra, hooks };
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

async function findTranscript(sessionId: string): Promise<string | null> {
  const root = projectsDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(root, entry, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

export function toClaudeMcpConfig(servers: McpServer[]) {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if ("command" in server) {
      mcpServers[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map((variable) => [variable.name, variable.value])),
      };
    } else if ("url" in server) {
      mcpServers[server.name] = {
        type: server.type === "sse" ? "sse" : "http",
        url: server.url,
        headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      };
    }
  }
  return { mcpServers };
}

type Block = Record<string, unknown> & { type?: string };
type Rec = {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string;
    usage?: Record<string, unknown>;
  };
};

export class ClaudeTranscriptParser implements TranscriptParser {
  private readonly openToolCalls = new Map<string, string>();
  private readonly announced = new Set<string>();
  private readonly settled = new Set<string>();

  markAnnounced(toolCallId: string): void {
    this.announced.add(toolCallId);
  }

  markSettled(toolCallId: string): void {
    this.settled.add(toolCallId);
  }

  parse(raw: unknown, options: { replay: boolean }): DriverEvent[] {
    const record = raw as Rec;
    if (!record || typeof record !== "object" || record.isSidechain) return [];
    if (record.type === "system" && record.subtype === "turn_duration") return [{ type: "turn_end" }];
    if (record.type === "assistant") return this.parseAssistant(record);
    if (record.type === "user") return this.parseUser(record, options.replay);
    return [];
  }

  private parseAssistant(record: Rec): DriverEvent[] {
    const message = record.message;
    if (!message || message.model === "<synthetic>") return [];
    const events: DriverEvent[] = [];
    for (const block of asBlocks(message.content)) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        events.push(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } }));
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        events.push(update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } }));
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        events.push(...this.toolUse(block.id, String(block.name ?? "tool"), block.input));
      }
    }
    if (message.id && message.usage) events.push({ type: "usage", messageId: message.id, usage: toUsage(message.usage) });
    if (message.stop_reason === "max_tokens") events.push({ type: "stop_reason", stopReason: "max_tokens" });
    if (message.stop_reason === "refusal") events.push({ type: "stop_reason", stopReason: "refusal" });
    return events;
  }

  private toolUse(id: string, name: string, input: unknown): DriverEvent[] {
    const args = (input ?? {}) as Record<string, unknown>;
    if (name === "TodoWrite" && Array.isArray(args.todos)) {
      return [update({ sessionUpdate: "plan", entries: args.todos.map(toPlanEntry) })];
    }
    this.openToolCalls.set(id, name);
    const locations = toolLocations(input);
    const content = toolContent(name, input);
    const fields = {
      toolCallId: id,
      title: toolTitle(name, input),
      kind: toolKind(name),
      status: "in_progress" as const,
      rawInput: input,
      ...(locations ? { locations } : {}),
      ...(content ? { content } : {}),
    };
    return [
      update(this.announced.has(id) ? { sessionUpdate: "tool_call_update", ...fields } : { sessionUpdate: "tool_call", ...fields }),
    ];
  }

  private parseUser(record: Rec, replay: boolean): DriverEvent[] {
    const content = record.message?.content;
    const events: DriverEvent[] = [];
    if (typeof content === "string") {
      if (replay && !record.isMeta && !isInternalText(content)) {
        events.push(update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: content } }));
      }
      return events;
    }
    for (const block of asBlocks(content)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const toolName = this.openToolCalls.get(block.tool_use_id);
        this.openToolCalls.delete(block.tool_use_id);
        if ((toolName === undefined || this.settled.delete(block.tool_use_id)) && !replay) continue;
        const keepsDiff = toolName !== undefined && EDIT_TOOLS.has(toolName) && !block.is_error;
        const text = keepsDiff ? "" : truncate(toolResultText(block.content));
        events.push(
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: block.tool_use_id,
            status: block.is_error ? "failed" : "completed",
            ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
          }),
        );
      } else if (replay && block.type === "text" && typeof block.text === "string" && !record.isMeta && !isInternalText(block.text)) {
        events.push(update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } }));
      }
    }
    return events;
  }
}

function update(value: SessionUpdate): DriverEvent {
  return { type: "update", update: value };
}

function asBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((block) => block && typeof block === "object") as Block[]) : [];
}

function isInternalText(text: string): boolean {
  return /^\s*<(command-|local-command-|system-reminder|bash-|user-prompt-submit-hook)/.test(text);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return asBlocks(content)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… [truncated]` : text;
}

function toUsage(usage: Record<string, unknown>): TokenUsage {
  const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    cachedReadTokens: num("cache_read_input_tokens"),
    cachedWriteTokens: num("cache_creation_input_tokens"),
    thoughtTokens: typeof details.thinking_tokens === "number" ? details.thinking_tokens : 0,
  };
}

function toPlanEntry(todo: unknown): PlanEntry {
  const item = (todo ?? {}) as Record<string, unknown>;
  const status = item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
  return { content: String(item.content ?? ""), status, priority: "medium" };
}
