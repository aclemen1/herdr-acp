import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentContext,
  ClientCapabilities,
  ContentBlock,
  CreateElicitationResponse,
  ElicitationSchema,
  McpServer,
  PermissionOption,
  PromptResponse,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { CLIENT_METHODS, RequestError } from "@agentclientprotocol/sdk";
import { elicitationContent } from "./elicitation.ts";
import type { Driver, HookHost, TokenUsage, TranscriptParser } from "./drivers/types.ts";
import { type AgentInfo, type Herdr, HerdrError } from "./herdr.ts";
import { hookCommand, HookServer, socketPath } from "./hook-bridge.ts";
import { JsonlTail } from "./jsonl-tail.ts";
import { promptToText } from "./prompt.ts";

export type SessionConfig = {
  herdr: Herdr;
  driver: Driver;
  workspaceLabel: string;
  paneEnv: Record<string, string>;
  extraArgs: string[];
  stateDir: string;
  startTimeoutMs: number;
  pollMs: number;
  idleSettleMs: number;
  trustFolders: boolean;
  client: { capabilities: ClientCapabilities | null };
};

export type RequestContext = { client: AgentContext; requestId: string | number | null };

type Placement = { paneId: string; tabId: string | null };
type Turn = { cancelled: boolean; streamed: string; continuation: { modeId: string; prompt: string } | null };

let placementQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = placementQueue.then(task, task);
  placementQueue = next.catch(() => undefined);
  return next;
}

export class Session implements HookHost {
  readonly sessionId: string;
  readonly cwd: string;
  private paneId: string;
  private readonly ownedTabId: string | null;
  private readonly config: SessionConfig;
  private readonly client: AgentContext;
  private readonly parser: TranscriptParser;
  private hookServer: HookServer | null = null;
  private turn: Turn | null = null;
  private readonly modes: SessionMode[];
  private mode: string;
  private pendingMode: string | null = null;
  private restarting: Promise<void> = Promise.resolve();
  private readonly mcpServers: McpServer[];
  private readonly canRestart: boolean;

  private constructor(
    config: SessionConfig,
    client: AgentContext,
    id: string,
    cwd: string,
    placement: Placement,
    init: { mode: string; mcpServers: McpServer[]; canRestart: boolean },
  ) {
    this.config = config;
    this.client = client;
    this.sessionId = id;
    this.cwd = cwd;
    this.paneId = placement.paneId;
    this.ownedTabId = placement.tabId;
    this.parser = config.driver.createParser();
    this.modes = config.driver.availableModes(config.extraArgs);
    this.mode = init.mode;
    this.mcpServers = init.mcpServers;
    this.canRestart = init.canRestart;
  }

  get modeState(): SessionModeState {
    return { currentModeId: this.mode, availableModes: this.modes };
  }

  get pane(): string {
    return this.paneId;
  }

  static async create(
    config: SessionConfig,
    params: { cwd: string; mcpServers: McpServer[] },
    ctx: RequestContext,
  ): Promise<Session> {
    const trusted = await ensureTrust(config, params.cwd, ctx);
    const id = config.driver.newSessionId();
    const placement = await placePane(config, id, params.cwd);
    const mode = await config.driver.initialMode(config.extraArgs);
    const session = new Session(config, ctx.client, id, params.cwd, placement, {
      mode,
      mcpServers: params.mcpServers,
      canRestart: true,
    });
    await session.listenHooks();
    await session.start({ resume: false, trusted });
    return session;
  }

  static async load(
    config: SessionConfig,
    params: { sessionId: string; cwd: string; mcpServers: McpServer[] },
    ctx: RequestContext,
  ): Promise<Session | null> {
    const mode = await config.driver.initialMode(config.extraArgs);
    const live = await findLiveAgent(config, params.sessionId);
    if (live) {
      const workspace = (await config.herdr.listWorkspaces()).find((ws) => ws.workspace_id === live.workspace_id);
      const session = new Session(
        config,
        ctx.client,
        params.sessionId,
        live.cwd ?? params.cwd,
        { paneId: live.pane_id, tabId: null },
        { mode, mcpServers: params.mcpServers, canRestart: workspace?.label === config.workspaceLabel },
      );
      await session.listenHooks();
      return session;
    }
    if (!(await config.driver.transcriptExists(params.sessionId))) return null;
    const trusted = await ensureTrust(config, params.cwd, ctx);
    const placement = await placePane(config, params.sessionId, params.cwd);
    const session = new Session(config, ctx.client, params.sessionId, params.cwd, placement, {
      mode,
      mcpServers: params.mcpServers,
      canRestart: true,
    });
    await session.listenHooks();
    await session.start({ resume: true, trusted });
    return session;
  }

  async replayHistory(): Promise<void> {
    const agent = await this.config.herdr.getAgent(this.paneId);
    const path = await this.config.driver.transcriptPath({
      sessionId: this.sessionId,
      cwd: this.cwd,
      ref: agent.agent_session ?? null,
    });
    const parser = this.config.driver.createParser();
    for (const record of await new JsonlTail(path).readNew()) {
      for (const event of parser.parse(record, { replay: true })) {
        if (event.type === "update") await this.notify(event.update);
      }
    }
  }

  async prompt(blocks: ContentBlock[]): Promise<PromptResponse> {
    if (this.turn) throw new Error(`Session ${this.sessionId} already has a prompt in progress`);
    const text = promptToText(blocks);
    await this.restarting;
    const turn: Turn = { cancelled: false, streamed: "", continuation: null };
    this.turn = turn;
    try {
      return await this.runTurn(text, turn);
    } finally {
      this.turn = null;
      const pending = this.takePendingMode();
      if (pending) this.restarting = this.restartWithMode(pending).catch((error) => this.reportRestartFailure(error));
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.modes.some((mode) => mode.id === modeId)) {
      throw RequestError.invalidParams({ modeId }, `unknown mode: ${modeId}`);
    }
    if (!this.canRestart) {
      throw RequestError.invalidParams(
        { modeId },
        `the mode of a session started outside herdr-acp can only be changed in its herdr pane (${this.paneId})`,
      );
    }
    if (this.turn) {
      this.pendingMode = modeId === this.mode ? null : modeId;
      return;
    }
    await this.restarting;
    if (modeId === this.mode) return;
    this.restarting = this.restartWithMode(modeId);
    await this.restarting;
  }

  async reportMode(modeId: string): Promise<void> {
    if (this.pendingMode === modeId) this.pendingMode = null;
    if (modeId === this.mode || !this.modes.some((mode) => mode.id === modeId)) return;
    this.mode = modeId;
    await this.notify({ sessionUpdate: "current_mode_update", currentModeId: modeId });
  }

  continueWithMode(modeId: string, prompt: string): void {
    if (this.turn) this.turn.continuation = { modeId, prompt };
  }

  takePendingMode(): string | null {
    const pending = this.pendingMode;
    this.pendingMode = null;
    return pending;
  }

  restorePendingMode(modeId: string): void {
    this.pendingMode ??= modeId;
  }

  private async restartWithMode(modeId: string): Promise<void> {
    const { herdr, driver } = this.config;
    await herdr.prompt(this.paneId, driver.exitCommand);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const agent = await herdr.getAgent(this.paneId).catch(() => null);
      if (!agent || agent.agent !== driver.kind) break;
      if (Date.now() > deadline) throw new Error(`${driver.title} did not exit in herdr pane ${this.paneId}`);
      await sleep(this.config.pollMs);
    }
    const resume = await driver.transcriptExists(this.sessionId);
    await this.start({ resume, trusted: true, mode: modeId });
    await this.reportMode(modeId);
  }

  private reportRestartFailure(error: unknown): void {
    process.stderr.write(`herdr-acp: mode change failed for session ${this.sessionId}: ${String(error)}\n`);
  }

  async cancel(): Promise<void> {
    if (!this.turn) return;
    this.turn.cancelled = true;
    await this.config.herdr.sendKeys(this.paneId, ["esc"]).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.cancel();
    await this.dispose();
    if (this.ownedTabId) await this.config.herdr.closeTab(this.ownedTabId).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.hookServer?.close();
    this.hookServer = null;
  }

  async notify(update: SessionUpdate): Promise<void> {
    await this.client.notify(CLIENT_METHODS.session_update, { sessionId: this.sessionId, update });
  }

  announceToolCall(toolCallId: string): void {
    this.parser.markAnnounced(toolCallId);
  }

  settleToolCall(toolCallId: string): void {
    this.parser.markSettled(toolCallId);
  }

  async streamText(text: string): Promise<void> {
    if (this.turn) this.turn.streamed += normalizeText(text);
    await this.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  async requestPermission(toolCall: ToolCallUpdate, options: PermissionOption[]): Promise<string | null> {
    const response = await this.client.request(CLIENT_METHODS.session_request_permission, {
      sessionId: this.sessionId,
      toolCall,
      options,
    });
    return response.outcome.outcome === "selected" ? response.outcome.optionId : null;
  }

  async elicit(request: {
    message: string;
    schema: ElicitationSchema;
    toolCallId?: string;
  }): Promise<CreateElicitationResponse | null> {
    if (!this.config.client.capabilities?.elicitation?.form) return null;
    return this.client.request(CLIENT_METHODS.elicitation_create, {
      mode: "form",
      sessionId: this.sessionId,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      message: request.message,
      requestedSchema: request.schema,
    });
  }

  markCancelled(): void {
    if (this.turn) this.turn.cancelled = true;
  }

  private async listenHooks(): Promise<void> {
    const handle = this.config.driver.createHookHandler(this);
    this.hookServer = await HookServer.listen(socketPath(this.config.stateDir, this.sessionId), (input) =>
      this.turn ? handle(input) : Promise.resolve(null),
    );
  }

  private async start(opts: { resume: boolean; trusted: boolean; mode?: string }): Promise<void> {
    const { herdr, driver } = this.config;
    const args = await driver.launchArgs({
      sessionId: this.sessionId,
      resume: opts.resume,
      cwd: this.cwd,
      mcpServers: this.mcpServers,
      stateDir: this.config.stateDir,
      extraArgs: this.config.extraArgs,
      hookCommand: hookCommand(),
      ...(opts.mode ? { mode: opts.mode } : {}),
    });
    const deadline = Date.now() + this.config.startTimeoutMs;
    let name = `acp-${this.sessionId.slice(0, 8).toLowerCase()}`;
    for (;;) {
      try {
        const agent = await herdr.startAgent({
          name,
          kind: driver.kind,
          paneId: this.paneId,
          args,
          timeoutMs: Math.max(5_000, deadline - Date.now()),
        });
        this.paneId = agent.pane_id;
        return;
      } catch (error) {
        if (!(error instanceof HerdrError) || Date.now() > deadline) throw error;
        if (error.code === "agent_pane_busy") {
          await sleep(500);
          continue;
        }
        if (error.code === "agent_not_ready") break;
        if (/name/i.test(error.code)) {
          name = `acp-${this.sessionId.slice(0, 8).toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`;
          continue;
        }
        throw error;
      }
    }
    await this.settleStartup(opts.trusted, deadline);
  }

  private async settleStartup(trustedBeforeLaunch: boolean, deadline: number): Promise<void> {
    const { herdr, driver } = this.config;
    let trustAnswered = false;
    while (Date.now() < deadline) {
      const agent = await herdr.getAgent(this.paneId);
      if ((agent.agent_status === "idle" || agent.agent_status === "done") && !agent.launch_pending) {
        if (trustAnswered && !(await driver.isFolderTrusted(this.cwd))) {
          throw new Error(`The trust answer for ${this.cwd} was not recorded by ${driver.title}`);
        }
        return;
      }
      if (agent.agent_status === "blocked") {
        if (trustedBeforeLaunch || trustAnswered) {
          throw new Error(`${driver.title} is blocked during startup in herdr pane ${this.paneId}`);
        }
        await herdr.sendKeys(this.paneId, driver.acceptTrustKeys);
        trustAnswered = true;
      }
      await sleep(this.config.pollMs);
    }
    throw new Error(`${driver.title} did not become ready within ${this.config.startTimeoutMs} ms`);
  }

  private async runTurn(text: string, turn: Turn): Promise<PromptResponse> {
    const usage = new Map<string, TokenUsage>();
    const outcome = { stopReason: "end_turn" as StopReason };
    let next: string | null = text;
    while (next !== null) {
      await this.followPrompt(next, turn, usage, outcome);
      next = null;
      const continuation = turn.continuation;
      turn.continuation = null;
      if (continuation && !turn.cancelled) {
        await this.restartWithMode(continuation.modeId);
        next = continuation.prompt;
      }
    }
    return { stopReason: turn.cancelled ? "cancelled" : outcome.stopReason, ...usageResponse(usage) };
  }

  private async followPrompt(
    text: string,
    turn: Turn,
    usage: Map<string, TokenUsage>,
    outcome: { stopReason: StopReason },
  ): Promise<void> {
    const { herdr, driver, pollMs, idleSettleMs } = this.config;
    const agent = await herdr.getAgent(this.paneId);
    const path = await driver.transcriptPath({ sessionId: this.sessionId, cwd: this.cwd, ref: agent.agent_session ?? null });
    const tail = await JsonlTail.atEnd(path);
    let sawActivity = false;
    let blockedReported = false;
    let quietSince: number | null = null;
    const startedAt = Date.now();

    await herdr.prompt(this.paneId, text);

    for (;;) {
      let turnEnded = false;
      const records = await tail.readNew();
      if (records.length > 0) {
        sawActivity = true;
        quietSince = null;
      }
      for (const record of records) {
        for (const event of this.parser.parse(record, { replay: false })) {
          if (event.type === "update") {
            if (!isAlreadyStreamed(turn, event.update)) await this.notify(event.update);
          } else if (event.type === "usage") usage.set(event.messageId, event.usage);
          else if (event.type === "stop_reason") outcome.stopReason = event.stopReason;
          else if (event.type === "turn_end") turnEnded = true;
        }
      }
      if (turnEnded) return;

      const status = (await herdr.getAgent(this.paneId)).agent_status;
      if (status === "working") {
        sawActivity = true;
        quietSince = null;
        blockedReported = false;
      } else if (status === "blocked") {
        sawActivity = true;
        quietSince = null;
        if (!blockedReported) {
          blockedReported = true;
          process.stderr.write(`herdr-acp: ${driver.title} waits for input in herdr pane ${this.paneId}\n`);
        }
      } else if (status === "idle" || status === "done") {
        if (sawActivity || turn.cancelled || Date.now() - startedAt > 10_000) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= idleSettleMs) return;
        }
      }
      await sleep(pollMs);
    }
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "");
}

function isAlreadyStreamed(turn: Turn, update: SessionUpdate): boolean {
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return false;
  const text = normalizeText(update.content.text);
  if (text && turn.streamed.startsWith(text)) {
    turn.streamed = turn.streamed.slice(text.length);
    return true;
  }
  turn.streamed = "";
  return false;
}

async function ensureTrust(config: SessionConfig, cwd: string, ctx: RequestContext): Promise<boolean> {
  if (await config.driver.isFolderTrusted(cwd)) return true;
  if (config.client.capabilities?.elicitation?.form && ctx.requestId !== null) {
    const response = await ctx.client.request(CLIENT_METHODS.elicitation_create, {
      mode: "form",
      requestId: ctx.requestId,
      message: `${config.driver.title} has not been trusted in ${cwd}. It will be able to read, edit and execute files there.`,
      requestedSchema: {
        type: "object",
        properties: { trust: { type: "boolean", title: `Trust ${cwd}`, default: false } },
        required: ["trust"],
      },
    });
    if (response.action === "accept" && elicitationContent(response).trust === true) return false;
    throw RequestError.invalidParams({ cwd }, `folder not trusted: ${cwd}`);
  }
  if (config.trustFolders) return false;
  throw RequestError.invalidParams(
    { cwd },
    `folder not trusted by ${config.driver.title}: ${cwd}. Trust it once interactively, or start herdr-acp with --trust-folders`,
  );
}

export async function listLiveSessions(config: SessionConfig, cwd?: string | null) {
  const agents = await config.herdr.listAgents();
  return agents
    .filter((agent) => agent.agent === config.driver.kind && agent.agent_session?.kind === "id")
    .filter((agent) => !cwd || agent.cwd === cwd)
    .map((agent) => ({
      sessionId: agent.agent_session!.value,
      cwd: agent.cwd ?? "",
      title: agent.terminal_title_stripped ?? null,
      _meta: { herdr: { paneId: agent.pane_id, status: agent.agent_status } },
    }));
}

async function findLiveAgent(config: SessionConfig, sessionId: string): Promise<AgentInfo | null> {
  const agents = await config.herdr.listAgents();
  return agents.find((agent) => agent.agent === config.driver.kind && agent.agent_session?.value === sessionId) ?? null;
}

function placePane(config: SessionConfig, sessionId: string, cwd: string): Promise<Placement> {
  return serialized(async () => {
    const { herdr, workspaceLabel } = config;
    const env = { ...config.paneEnv, HERDR_ACP_SOCKET: socketPath(config.stateDir, sessionId) };
    const label = `${config.driver.kind} ${sessionId.slice(0, 8)}`;
    const workspace = (await herdr.listWorkspaces()).find((ws) => ws.label === workspaceLabel);
    if (!workspace) {
      const created = await herdr.createWorkspace({ label: workspaceLabel, cwd, env });
      return { paneId: created.root_pane.pane_id, tabId: created.tab.tab_id };
    }
    const created = await herdr.createTab({ workspaceId: workspace.workspace_id, label, cwd, env });
    return { paneId: created.root_pane.pane_id, tabId: created.tab.tab_id };
  });
}

function usageResponse(usage: Map<string, TokenUsage>): Pick<PromptResponse, "usage"> {
  if (usage.size === 0) return {};
  const total = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 };
  for (const item of usage.values()) {
    total.inputTokens += item.inputTokens + item.cachedReadTokens + item.cachedWriteTokens;
    total.outputTokens += item.outputTokens;
    total.cachedReadTokens += item.cachedReadTokens;
    total.cachedWriteTokens += item.cachedWriteTokens;
    total.thoughtTokens += item.thoughtTokens;
  }
  return { usage: { ...total, totalTokens: total.inputTokens + total.outputTokens } };
}
