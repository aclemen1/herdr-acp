import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { CLIENT_METHODS, RequestError } from "@agentclientprotocol/sdk";
import { selectValues } from "./config-options.ts";
import { elicitationContent } from "./elicitation.ts";
import type { Driver, HookHost, LaunchInput, SessionSettings, StatusReport, TokenUsage, TranscriptParser } from "./drivers/types.ts";
import { type AgentInfo, type Herdr, HerdrError } from "./herdr.ts";
import { envFilePath, hookCommand, HookServer, renderEnvFile, socketPath, statusLineCommand } from "./hook-bridge.ts";
import { JsonlTail } from "./jsonl-tail.ts";
import { type Interaction, readSessionPrefs, writeSessionPrefs } from "./session-prefs.ts";
import { acquireOwnership, checkOwnership, type Owner, releaseOwnership } from "./ownership.ts";
import { deletePaneRecord, listPaneRecords, readPaneRecord, writePaneRecord } from "./pane-records.ts";
import { planReattach, releasePane, stopAgent } from "./pane-release.ts";
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
  closePanesOnExit: boolean;
  defaultInteraction: Interaction;
  client: { capabilities: ClientCapabilities | null };
};

export type RequestContext = { client: AgentContext; requestId: string | number | null };

// tabId: the tab herdr-acp owns now; createdTabId: the tab it created for this pane, even if the
// pane has since been moved out of it (the pane then still belongs to herdr-acp, the tab does not).
type Placement = { paneId: string; tabId: string | null; observedTabId?: string; createdTabId?: string };
type Turn = {
  cancelled: boolean;
  streamed: string;
  continuation: { modeId: string; prompt: string } | null;
  queueDepth: number;
  steersInFlight: string[];
  streamedThoughts: string;
  ended: boolean;
};

export type SteerOutcome = { outcome: "injected" | "startedNewTurn" | "promptRequired"; reason?: string };
type LaunchChange = { mode?: string; model?: string; effort?: string };
export type InitialConfig = { mode?: string; model?: string; effort?: string };
export type Delivery = "now" | "queue";

const INITIAL_CONFIG_KEYS = ["mode", "model", "effort"] as const;

function validateInitialConfig(config: SessionConfig, settings: SessionSettings, initial: InitialConfig): InitialConfig {
  const options = config.driver.configOptions(settings, config.driver.availableModes(config.extraArgs), null);
  const valid: InitialConfig = {};
  for (const key of INITIAL_CONFIG_KEYS) {
    const value = initial[key];
    if (value === undefined) continue;
    if (!selectValues(options, key).includes(value)) {
      throw RequestError.invalidParams({ configId: key, value }, `unsupported value for ${key}: ${value}`);
    }
    valid[key] = value;
  }
  return valid;
}

const STATUS_WAIT_MS = 3_000;
const ENV_WAIT_MS = 3_000;
const EXIT_WAIT_MS = 5_000;
const QUEUED_CONFIRM_MS = 5_000;
// Covers a herdr live handoff, which cuts in-flight CLI calls.
const HERDR_OUTAGE_MS = 30_000;
const ALWAYS_HANDLED_HOOKS = new Set(["StatusLine", "SessionStart", "FileChanged", "CwdChanged"]);

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
  private readonly observedTabId: string | null;
  private readonly createdTabId: string | null;
  private readonly config: SessionConfig;
  private readonly client: AgentContext;
  private readonly parser: TranscriptParser;
  private hookServer: HookServer | null = null;
  private turn: Turn | null = null;
  owner: Owner | null = null;
  private readonly interactionMode: Interaction;
  private readonly modes: SessionMode[];
  private readonly settings: SessionSettings;
  private readonly overrides: { model?: string; effort?: string };
  private pendingMode: string | null = null;
  private pendingConfig: { model?: string; effort?: string } = {};
  private restarting: Promise<void> = Promise.resolve();
  private promptChain: Promise<unknown> = Promise.resolve();
  private cancelGeneration = 0;
  private readonly mcpServers: McpServer[];
  private readonly canRestart: boolean;
  private modelLabel: string | null = null;
  private lastModelId: string | null = null;
  private context: { used: number; size: number } | null = null;
  private rateLimits: Record<string, unknown> | null = null;
  private statusSeen: () => void = () => undefined;
  private envSeen: () => void = () => undefined;
  private envSeenPromise: Promise<void> = Promise.resolve();
  private readonly firstStatus = new Promise<void>((resolve) => {
    this.statusSeen = resolve;
  });

  private constructor(
    config: SessionConfig,
    client: AgentContext,
    id: string,
    cwd: string,
    placement: Placement,
    init: {
      settings: SessionSettings;
      mcpServers: McpServer[];
      canRestart: boolean;
      interaction: Interaction;
      overrides?: { model?: string; effort?: string };
    },
  ) {
    this.config = config;
    this.client = client;
    this.sessionId = id;
    this.cwd = cwd;
    this.paneId = placement.paneId;
    this.ownedTabId = placement.tabId;
    this.observedTabId = placement.observedTabId ?? null;
    this.createdTabId = placement.createdTabId ?? placement.tabId;
    this.parser = config.driver.createParser();
    this.modes = config.driver.availableModes(config.extraArgs);
    this.settings = { ...init.settings };
    this.overrides = { ...(init.overrides ?? {}) };
    this.interactionMode = init.interaction;
    this.mcpServers = init.mcpServers;
    this.canRestart = init.canRestart;
  }

  get modeState(): SessionModeState {
    return { currentModeId: this.settings.mode, availableModes: this.modes };
  }

  get configOptions(): SessionConfigOption[] {
    return this.config.driver.configOptions(this.settings, this.modes, this.modelLabel);
  }

  get tab(): string | null {
    return this.ownedTabId ?? this.observedTabId;
  }

  get ownsTab(): boolean {
    return this.ownedTabId !== null;
  }

  get pane(): string {
    return this.paneId;
  }

  static async create(
    config: SessionConfig,
    params: { cwd: string; mcpServers: McpServer[]; initial?: InitialConfig; interaction?: Interaction; tabLabel?: string },
    ctx: RequestContext,
  ): Promise<Session> {
    const interaction = params.interaction ?? config.defaultInteraction;
    const settings = await config.driver.initialSettings(config.extraArgs);
    const initial = validateInitialConfig(config, settings, params.initial ?? {});
    const trusted = await ensureTrust(config, params.cwd, ctx);
    const id = config.driver.newSessionId();
    const owner = await acquireOwnership(config.stateDir, id, false);
    await writeSessionPrefs(config.stateDir, id, { interaction });
    const placement = await placePane(config, id, params.cwd, params.tabLabel);
    const session = new Session(config, ctx.client, id, params.cwd, placement, {
      settings: { ...settings, ...initial },
      mcpServers: params.mcpServers,
      canRestart: true,
      interaction,
      overrides: { ...(initial.model ? { model: initial.model } : {}), ...(initial.effort ? { effort: initial.effort } : {}) },
    });
    session.owner = owner;
    await session.listenHooks();
    await session.writeEnvFile();
    try {
      await session.start({ resume: false, trusted, ...(initial.mode ? { mode: initial.mode } : {}) });
    } catch (error) {
      await session.close();
      throw error;
    }
    await session.waitForStatus();
    return session;
  }

  static async fork(
    config: SessionConfig,
    params: { sessionId: string; cwd: string; mcpServers: McpServer[]; interaction?: Interaction; tabLabel?: string },
    ctx: RequestContext,
  ): Promise<Session | null> {
    if (!(await config.driver.transcriptExists(params.sessionId))) return null;
    const interaction =
      params.interaction ?? (await readSessionPrefs(config.stateDir, params.sessionId)).interaction ?? config.defaultInteraction;
    const trusted = await ensureTrust(config, params.cwd, ctx);
    const id = config.driver.newSessionId();
    const owner = await acquireOwnership(config.stateDir, id, false);
    await writeSessionPrefs(config.stateDir, id, { interaction });
    const placement = await placePane(config, id, params.cwd, params.tabLabel);
    const settings = await config.driver.initialSettings(config.extraArgs);
    const session = new Session(config, ctx.client, id, params.cwd, placement, {
      settings,
      mcpServers: params.mcpServers,
      canRestart: true,
      interaction,
    });
    session.owner = owner;
    await session.listenHooks();
    await session.writeEnvFile();
    try {
      await session.start({ resume: false, trusted, forkFrom: params.sessionId });
    } catch (error) {
      await session.close();
      throw error;
    }
    await session.waitForStatus();
    return session;
  }

  // Reuses the pane herdr-acp itself launched for this session, found through its own pane record.
  private static async reattach(
    config: SessionConfig,
    params: { sessionId: string; cwd: string; mcpServers: McpServer[]; interaction: Interaction; tabLabel?: string },
    ctx: RequestContext,
    settings: SessionSettings,
  ): Promise<Session | null> {
    const record = await readPaneRecord(config.stateDir, params.sessionId);
    if (!record || record.kind !== config.driver.kind || record.target !== config.herdr.target) return null;
    const plan = await planReattach(config.herdr, record);
    if (!plan) {
      await deletePaneRecord(config.stateDir, params.sessionId);
      return null;
    }
    const { pane, owned } = plan;
    if (plan.renamedId) await writePaneRecord(config.stateDir, { ...record, paneId: pane.pane_id });
    const agent = await config.herdr.getAgent(pane.pane_id).catch(() => null);
    const ref = agent?.agent_session ? config.driver.sessionIdFromRef(agent.agent_session) : null;
    const running = agent?.agent === config.driver.kind && (ref === null || ref === params.sessionId);
    if (agent?.agent && !running) {
      await deletePaneRecord(config.stateDir, params.sessionId);
      return null;
    }
    const session = new Session(
      config,
      ctx.client,
      params.sessionId,
      record.cwd,
      owned
        ? { paneId: pane.pane_id, tabId: pane.tab_id }
        : { paneId: pane.pane_id, tabId: null, observedTabId: pane.tab_id, createdTabId: record.tabId },
      { settings, mcpServers: params.mcpServers, canRestart: true, interaction: params.interaction },
    );
    await session.listenHooks();
    if (owned && params.tabLabel) await config.herdr.renameTab(pane.tab_id, params.tabLabel);
    if (running && (await session.launchedByHerdrAcp())) {
      if ((await session.writeEnvFile()) && config.driver.envAcknowledged) await session.waitForEnv();
      await session.declareResumeCommand();
      return session;
    }
    await session.writeEnvFile();
    if (running) {
      process.stderr.write(`herdr-acp: ${config.driver.title} in herdr pane ${pane.pane_id} runs without herdr-acp's settings; relaunching it\n`);
      try {
        await session.restartWith({});
      } catch (error) {
        await session.close();
        throw error;
      }
      await session.waitForStatus();
      return session;
    }
    try {
      await session.start({ resume: await config.driver.transcriptExists(params.sessionId), trusted: true });
    } catch (error) {
      await session.close();
      throw error;
    }
    await session.waitForStatus();
    return session;
  }

  static async load(
    config: SessionConfig,
    params: {
      sessionId: string;
      cwd: string;
      mcpServers: McpServer[];
      takeover?: boolean;
      interaction?: Interaction;
      tabLabel?: string;
    },
    ctx: RequestContext,
  ): Promise<Session | null> {
    const owner = await acquireOwnership(config.stateDir, params.sessionId, params.takeover === true);
    try {
      const stored = (await readSessionPrefs(config.stateDir, params.sessionId)).interaction;
      const interaction = params.interaction ?? stored ?? config.defaultInteraction;
      if (interaction !== stored) await writeSessionPrefs(config.stateDir, params.sessionId, { interaction });
      const session = await Session.attach(config, { ...params, interaction }, ctx);
      if (!session) await releaseOwnership(config.stateDir, params.sessionId, owner);
      else session.owner = owner;
      return session;
    } catch (error) {
      await releaseOwnership(config.stateDir, params.sessionId, owner);
      throw error;
    }
  }

  private static async attach(
    config: SessionConfig,
    params: { sessionId: string; cwd: string; mcpServers: McpServer[]; interaction: Interaction; tabLabel?: string },
    ctx: RequestContext,
  ): Promise<Session | null> {
    const settings = await config.driver.initialSettings(config.extraArgs);
    const reattached = await Session.reattach(config, params, ctx, settings);
    if (reattached) return reattached;
    const live = await findLiveAgent(config, params.sessionId);
    if (live) {
      const workspace = (await config.herdr.listWorkspaces()).find((ws) => ws.workspace_id === live.workspace_id);
      const session = new Session(
        config,
        ctx.client,
        params.sessionId,
        live.cwd ?? params.cwd,
        { paneId: live.pane_id, tabId: null, observedTabId: live.tab_id },
        { settings, mcpServers: params.mcpServers, canRestart: workspace?.label === config.workspaceLabel, interaction: params.interaction },
      );
      await session.listenHooks();
      if ((await session.writeEnvFile()) && config.driver.envAcknowledged) await session.waitForEnv();
      return session;
    }
    if (!(await config.driver.transcriptExists(params.sessionId))) return null;
    const trusted = await ensureTrust(config, params.cwd, ctx);
    const placement = await placePane(config, params.sessionId, params.cwd, params.tabLabel);
    const session = new Session(config, ctx.client, params.sessionId, params.cwd, placement, {
      settings,
      mcpServers: params.mcpServers,
      canRestart: true,
      interaction: params.interaction,
    });
    await session.listenHooks();
    await session.writeEnvFile();
    try {
      await session.start({ resume: true, trusted });
    } catch (error) {
      await session.close();
      throw error;
    }
    await session.waitForStatus();
    return session;
  }

  async announceCommands(): Promise<void> {
    let latest: SessionUpdate | null = null;
    await this.readHistory((update) => {
      if (update.sessionUpdate === "available_commands_update") latest = update;
    });
    if (latest) await this.notify(latest);
  }

  private async readHistory(onUpdate: (update: SessionUpdate) => void | Promise<void>): Promise<void> {
    const agent = await this.config.herdr.getAgent(this.paneId);
    const path = await this.config.driver.transcriptPath({
      sessionId: this.sessionId,
      cwd: this.cwd,
      ref: agent.agent_session ?? null,
    });
    const parser = this.config.driver.createParser();
    for (const record of this.config.driver.replayOrder(await new JsonlTail(path).readNew())) {
      for (const event of parser.parse(record, { replay: true })) {
        if (event.type === "update") await onUpdate(event.update);
      }
    }
  }

  async replayHistory(): Promise<void> {
    await this.readHistory((update) => this.notify(update));
  }

  async prompt(blocks: ContentBlock[], delivery: Delivery = "now"): Promise<PromptResponse> {
    try {
      if (this.owner) await checkOwnership(this.config.stateDir, this.sessionId, this.owner);
    } catch (error) {
      await this.hookServer?.close();
      this.hookServer = null;
      throw error;
    }
    const generation = this.cancelGeneration;
    const run = this.promptChain.then(() =>
      generation === this.cancelGeneration ? this.runPrompt(blocks, delivery) : { stopReason: "cancelled" as const },
    );
    this.promptChain = run.catch(() => undefined);
    return run;
  }

  async steer(blocks: ContentBlock[], idleBehavior?: string): Promise<SteerOutcome> {
    const turn = this.turn;
    if (!turn) {
      if (idleBehavior === "promptRequired") return { outcome: "promptRequired", reason: "noRunningTurn" };
      this.prompt(blocks).catch((error) => {
        process.stderr.write(`herdr-acp: steered prompt failed for session ${this.sessionId}: ${String(error)}\n`);
      });
      return { outcome: "startedNewTurn" };
    }
    const text = await this.promptText(blocks);
    turn.steersInFlight.push(normalizeText(text));
    await this.config.herdr.prompt(this.paneId, text);
    return { outcome: "injected" };
  }

  private promptText(blocks: ContentBlock[]): Promise<string> {
    return promptToText(blocks, { attachmentDir: join(this.config.stateDir, "attachments") });
  }

  private async runPrompt(blocks: ContentBlock[], delivery: Delivery): Promise<PromptResponse> {
    const text = await this.promptText(blocks);
    await this.restarting;
    await this.refreshPaneId();
    const turn: Turn = {
      cancelled: false,
      streamed: "",
      streamedThoughts: "",
      continuation: null,
      queueDepth: 0,
      steersInFlight: [],
      ended: false,
    };
    this.turn = turn;
    try {
      return await this.runTurn(text, turn, delivery);
    } finally {
      this.turn = null;
      const change: LaunchChange = { ...this.pendingConfig };
      const pendingMode = this.takePendingMode();
      if (pendingMode) change.mode = pendingMode;
      this.pendingConfig = {};
      if (Object.keys(change).length > 0) {
        this.restarting = this.restartWith(change).catch((error) => this.reportRestartFailure(error));
      }
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.modes.some((mode) => mode.id === modeId)) {
      throw RequestError.invalidParams({ modeId }, `unknown mode: ${modeId}`);
    }
    if (!this.config.driver.modeRequiresRestart) {
      await this.reportMode(modeId);
      return;
    }
    this.assertRestartable("mode");
    if (this.turn) {
      this.pendingMode = modeId === this.settings.mode ? null : modeId;
      return;
    }
    await this.restarting;
    if (modeId === this.settings.mode) return;
    this.restarting = this.restartWith({ mode: modeId });
    await this.restarting;
  }

  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    if (configId === "mode") {
      await this.setMode(value);
      return this.configOptions;
    }
    if ((configId !== "model" && configId !== "effort") || !selectValues(this.configOptions, configId).includes(value)) {
      throw RequestError.invalidParams({ configId, value }, `unsupported value for ${configId}: ${value}`);
    }
    this.assertRestartable(configId);
    if ((this.settings[configId] ?? "default") === value) return this.configOptions;
    if (this.turn) {
      this.pendingConfig[configId] = value;
      return this.configOptions;
    }
    await this.restarting;
    this.restarting = this.restartWith({ [configId]: value });
    await this.restarting;
    return this.configOptions;
  }

  availableModeIds(): string[] {
    return this.modes.map((mode) => mode.id);
  }

  async reportStatus(status: StatusReport): Promise<void> {
    let configChanged = false;
    if (status.modelId) {
      if (this.lastModelId && status.modelId !== this.lastModelId && this.settings.model !== status.modelId) {
        this.settings.model = status.modelId;
      }
      this.lastModelId = status.modelId;
    }
    if (status.modelLabel && status.modelLabel !== this.modelLabel) {
      this.modelLabel = status.modelLabel;
      configChanged = true;
    }
    if (status.effort && status.effort !== this.settings.effort) {
      this.settings.effort = status.effort;
      configChanged = true;
    }
    if (status.rateLimits) this.rateLimits = status.rateLimits;
    if (configChanged) await this.notify({ sessionUpdate: "config_option_update", configOptions: this.configOptions });
    if (status.contextSize !== undefined && status.contextUsed !== undefined) {
      const next = { used: status.contextUsed, size: status.contextSize };
      if (next.used !== this.context?.used || next.size !== this.context?.size) {
        this.context = next;
        await this.notify({ sessionUpdate: "usage_update", used: next.used, size: next.size });
      }
    }
    this.statusSeen();
  }

  private async waitForStatus(): Promise<void> {
    await Promise.race([this.firstStatus, sleep(STATUS_WAIT_MS)]);
  }

  private assertRestartable(what: string): void {
    if (this.canRestart) return;
    throw RequestError.invalidParams(
      { what },
      `the ${what} of a session started outside herdr-acp can only be changed in its herdr pane (${this.paneId})`,
    );
  }

  async reportMode(modeId: string): Promise<void> {
    if (this.pendingMode === modeId) this.pendingMode = null;
    if (modeId === this.settings.mode || !this.modes.some((mode) => mode.id === modeId)) return;
    this.settings.mode = modeId;
    await this.notify({ sessionUpdate: "current_mode_update", currentModeId: modeId });
    await this.notify({ sessionUpdate: "config_option_update", configOptions: this.configOptions });
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

  private async restartWith(change: LaunchChange): Promise<void> {
    const { herdr, driver } = this.config;
    await this.refreshPaneId();
    if (!(await stopAgent(herdr, driver, this.paneId, { pollMs: this.config.pollMs, timeoutMs: 15_000 }))) {
      throw new Error(`${driver.title} did not exit in herdr pane ${this.paneId}`);
    }
    if (change.model) this.overrides.model = change.model;
    if (change.effort) this.overrides.effort = change.effort;
    const resume = await driver.transcriptExists(this.sessionId);
    await this.start({ resume, trusted: true, mode: change.mode ?? this.settings.mode });
    if (change.model) this.settings.model = change.model;
    if (change.effort) this.settings.effort = change.effort;
    if (change.mode) await this.reportMode(change.mode);
    if (change.model || change.effort) {
      await this.notify({ sessionUpdate: "config_option_update", configOptions: this.configOptions });
    }
  }

  private reportRestartFailure(error: unknown): void {
    process.stderr.write(`herdr-acp: settings change failed for session ${this.sessionId}: ${String(error)}\n`);
  }

  async cancel(): Promise<void> {
    this.cancelGeneration++;
    if (!this.turn) return;
    this.turn.cancelled = true;
    await this.config.herdr.sendKeys(this.paneId, ["esc"]).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.cancel();
    await this.dispose();
    await this.releaseOwnedTab();
  }

  // Process exit keeps the agent running unless --close-panes-on-exit; a pane started by hand is never closed.
  async shutdown(): Promise<void> {
    if (!this.createdTabId || !this.config.closePanesOnExit) return this.dispose();
    await this.close();
  }

  private async releaseOwnedTab(): Promise<void> {
    if (!this.createdTabId) return;
    const { herdr, driver, pollMs } = this.config;
    await releasePane(herdr, driver, { paneId: this.paneId, ownedTabId: this.ownedTabId }, { pollMs, timeoutMs: EXIT_WAIT_MS });
    await deletePaneRecord(this.config.stateDir, this.sessionId);
  }

  // A pane moved to another workspace gets a new id; herdr still resolves the old one.
  private async refreshPaneId(): Promise<void> {
    const pane = await this.config.herdr.getPane(this.paneId).catch(() => null);
    if (!pane || pane.pane_id === this.paneId) return;
    this.paneId = pane.pane_id;
    await this.recordPane();
  }

  async dispose(): Promise<void> {
    await this.hookServer?.close();
    this.hookServer = null;
    if (this.owner) await releaseOwnership(this.config.stateDir, this.sessionId, this.owner);
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

  async streamText(text: string, kind: "message" | "thought" = "message"): Promise<void> {
    if (this.turn) {
      if (kind === "message") this.turn.streamed += normalizeText(text);
      else this.turn.streamedThoughts += normalizeText(text);
    }
    await this.notify({
      sessionUpdate: kind === "message" ? "agent_message_chunk" : "agent_thought_chunk",
      content: { type: "text", text },
    });
  }

  interaction(): Interaction {
    return this.interactionMode;
  }

  currentMode(): string {
    return this.settings.mode;
  }

  endTurn(): void {
    if (this.turn) this.turn.ended = true;
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

  envApplied(): void {
    this.envSeen();
  }

  async writeEnvFile(): Promise<boolean> {
    const path = envFilePath(this.config.stateDir, this.sessionId);
    const content = renderEnvFile(this.config.paneEnv);
    const previous = await readFile(path, "utf8").catch(() => null);
    if (previous === content) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    this.envSeenPromise = new Promise((resolve) => {
      this.envSeen = resolve;
    });
    await writeFile(path, content, { mode: 0o600 });
    return previous !== null;
  }

  private async waitForEnv(): Promise<void> {
    await Promise.race([this.envSeenPromise, sleep(ENV_WAIT_MS)]);
  }

  markCancelled(): void {
    if (this.turn) this.turn.cancelled = true;
  }

  private async listenHooks(): Promise<void> {
    const handle = this.config.driver.createHookHandler(this);
    this.hookServer = await HookServer.listen(socketPath(this.config.stateDir, this.sessionId), (input) =>
      this.turn || isAlwaysHandled(input) ? handle(input) : Promise.resolve(null),
    );
  }

  private launchInput(opts: { resume: boolean; trusted: boolean; mode?: string; forkFrom?: string }): LaunchInput {
    return {
      sessionId: this.sessionId,
      resume: opts.resume,
      cwd: this.cwd,
      mcpServers: this.mcpServers,
      stateDir: this.config.stateDir,
      extraArgs: this.config.extraArgs,
      hookCommand: hookCommand(),
      statusLineCommand: statusLineCommand(),
      clientCanElicit: Boolean(this.config.client.capabilities?.elicitation?.form),
      trustApproved: !opts.trusted,
      interaction: this.interactionMode,
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.forkFrom ? { forkFrom: opts.forkFrom } : {}),
      ...this.overrides,
    };
  }

  // Without it, a herdr server restart resumes the agent without herdr-acp's settings, hooks and MCP servers.
  private async declareResumeCommand(mode?: string): Promise<void> {
    const { herdr, driver } = this.config;
    try {
      const args = await driver.launchArgs(this.launchInput({ resume: true, trusted: true, mode: mode ?? this.settings.mode }));
      await herdr.reportResumeCommand({ paneId: this.paneId, agent: driver.kind, sessionId: this.sessionId, argv: [driver.kind, ...args] });
    } catch (error) {
      process.stderr.write(`herdr-acp: could not declare the resume command of session ${this.sessionId}: ${String(error)}\n`);
    }
  }

  private async launchedByHerdrAcp(): Promise<boolean> {
    const argvs = await this.config.herdr.foregroundArgv(this.paneId).catch(() => null);
    if (!argvs) return true;
    return this.config.driver.launchedByHerdrAcp(argvs, { sessionId: this.sessionId, stateDir: this.config.stateDir });
  }

  private async start(opts: { resume: boolean; trusted: boolean; mode?: string; forkFrom?: string }): Promise<void> {
    const { herdr, driver } = this.config;
    const args = await driver.launchArgs(this.launchInput(opts));
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
        await this.recordPane();
        await this.declareResumeCommand(opts.mode);
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
    await this.recordPane();
    await this.declareResumeCommand(opts.mode);
  }

  private async recordPane(): Promise<void> {
    if (!this.createdTabId) return;
    await writePaneRecord(this.config.stateDir, {
      sessionId: this.sessionId,
      kind: this.config.driver.kind,
      target: this.config.herdr.target,
      paneId: this.paneId,
      tabId: this.createdTabId,
      cwd: this.cwd,
    });
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
        if (trustedBeforeLaunch || trustAnswered || driver.acceptTrustKeys.length === 0) {
          throw new Error(`${driver.title} is blocked during startup in herdr pane ${this.paneId}`);
        }
        await herdr.sendKeys(this.paneId, driver.acceptTrustKeys);
        trustAnswered = true;
      }
      await sleep(this.config.pollMs);
    }
    throw new Error(`${driver.title} did not become ready within ${this.config.startTimeoutMs} ms`);
  }

  private async runTurn(text: string, turn: Turn, delivery: Delivery): Promise<PromptResponse> {
    const usage = new Map<string, TokenUsage>();
    const outcome = { stopReason: "end_turn" as StopReason };
    let next: string | null = text;
    while (next !== null) {
      await this.followPrompt(next, turn, usage, outcome, delivery);
      next = null;
      delivery = "now";
      const continuation = turn.continuation;
      turn.continuation = null;
      if (continuation && !turn.cancelled) {
        await this.restartWith({ mode: continuation.modeId });
        next = continuation.prompt;
      }
    }
    return {
      stopReason: turn.cancelled ? "cancelled" : outcome.stopReason,
      ...usageResponse(usage),
      ...(this.rateLimits ? { _meta: { herdr: { rateLimits: this.rateLimits } } } : {}),
    };
  }

  private async deliverQueued(text: string, tail: JsonlTail, backlog: unknown[]): Promise<boolean> {
    const { driver, pollMs } = this.config;
    if (!driver.deliverQueued || !driver.confirmsQueued) return false;
    if (!(await driver.deliverQueued(this.sessionId, text))) return false;
    const deadline = Date.now() + QUEUED_CONFIRM_MS;
    while (Date.now() < deadline) {
      const records = await tail.readNew();
      backlog.push(...records);
      if (records.some((record) => driver.confirmsQueued!(record, text))) return true;
      await sleep(pollMs);
    }
    process.stderr.write(`herdr-acp: ${driver.title} did not confirm the queued prompt; typing it instead\n`);
    return false;
  }

  private async followPrompt(
    text: string,
    turn: Turn,
    usage: Map<string, TokenUsage>,
    outcome: { stopReason: StopReason },
    delivery: Delivery,
  ): Promise<void> {
    const { herdr, driver, pollMs, idleSettleMs } = this.config;
    const agent = await herdr.getAgent(this.paneId);
    const path = await driver.transcriptPath({ sessionId: this.sessionId, cwd: this.cwd, ref: agent.agent_session ?? null });
    const tail = await JsonlTail.atEnd(path);
    let sawActivity = false;
    let blockedReported = false;
    let quietSince: number | null = null;
    const startedAt = Date.now();
    const backlog: unknown[] = [];
    let herdrFailingSince: number | null = null;

    if (delivery !== "queue" || !(await this.deliverQueued(text, tail, backlog))) await herdr.prompt(this.paneId, text);

    for (;;) {
      let turnEnded = false;
      const records = [...backlog.splice(0), ...(await tail.readNew())];
      if (records.length > 0) {
        sawActivity = true;
        quietSince = null;
      }
      for (const record of records) {
        for (const event of this.parser.parse(record, { replay: false, since: startedAt - 1_000 })) {
          if (event.type === "update") {
            if (!isAlreadyStreamed(turn, event.update)) await this.notify(event.update);
          } else if (event.type === "usage") usage.set(event.messageId, event.usage);
          else if (event.type === "stop_reason") outcome.stopReason = event.stopReason;
          else if (event.type === "turn_end") turnEnded = true;
          else if (event.type === "queue") trackQueue(turn, event.change, event.content);
        }
      }
      if ((turnEnded || turn.ended) && !hasQueuedMessages(turn)) return;

      let status: AgentInfo["agent_status"];
      try {
        status = (await herdr.getAgent(this.paneId)).agent_status;
        herdrFailingSince = null;
      } catch (error) {
        if (!(error instanceof HerdrError)) throw error;
        herdrFailingSince ??= Date.now();
        if (Date.now() - herdrFailingSince > HERDR_OUTAGE_MS) throw error;
        status = "unknown";
      }
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
          if (Date.now() - quietSince >= idleSettleMs && !hasQueuedMessages(turn)) return;
        }
      }
      await sleep(pollMs);
    }
  }
}

function trackQueue(turn: Turn, change: "enqueue" | "dequeue" | "clear", content?: string): void {
  if (change === "clear") {
    turn.queueDepth = 0;
    turn.steersInFlight = [];
  } else if (change === "enqueue") {
    turn.queueDepth++;
    const index = content === undefined ? -1 : turn.steersInFlight.indexOf(normalizeText(content));
    if (index >= 0) turn.steersInFlight.splice(index, 1);
  } else {
    turn.queueDepth = Math.max(0, turn.queueDepth - 1);
  }
}

function hasQueuedMessages(turn: Turn): boolean {
  return !turn.cancelled && (turn.queueDepth > 0 || turn.steersInFlight.length > 0);
}

function isAlwaysHandled(input: unknown): boolean {
  return ALWAYS_HANDLED_HOOKS.has((input as { hook_event_name?: string } | null)?.hook_event_name ?? "");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "");
}

function isAlreadyStreamed(turn: Turn, update: SessionUpdate): boolean {
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return false;
  if (update.content.type !== "text") return false;
  const key = update.sessionUpdate === "agent_message_chunk" ? "streamed" : "streamedThoughts";
  const text = normalizeText(update.content.text);
  if (text && turn[key].startsWith(text)) {
    turn[key] = turn[key].slice(text.length);
    return true;
  }
  turn[key] = "";
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

export async function listSessions(config: SessionConfig, cwd?: string | null) {
  const live = new Map<string, AgentInfo>();
  const recorded = new Map(
    (await listPaneRecords(config.stateDir))
      .filter((record) => record.kind === config.driver.kind && record.target === config.herdr.target)
      .map((record) => [record.paneId, record.sessionId]),
  );
  for (const agent of await config.herdr.listAgents()) {
    const id = liveSessionId(config, agent) ?? (agent.agent === config.driver.kind ? recorded.get(agent.pane_id) : undefined);
    if (id) live.set(id, agent);
  }
  const stored = cwd ? await config.driver.listTranscripts(cwd) : [];
  const sessions = stored.map((entry) => {
    const agent = live.get(entry.sessionId);
    live.delete(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      cwd: agent?.cwd ?? cwd ?? "",
      title: entry.title ?? agent?.terminal_title_stripped ?? null,
      updatedAt: entry.updatedAt,
      ...(agent ? { _meta: { herdr: { paneId: agent.pane_id, status: agent.agent_status } } } : {}),
    };
  });
  for (const [sessionId, agent] of live) {
    if (cwd && agent.cwd !== cwd) continue;
    sessions.unshift({
      sessionId,
      cwd: agent.cwd ?? "",
      title: agent.terminal_title_stripped ?? null,
      updatedAt: new Date().toISOString(),
      _meta: { herdr: { paneId: agent.pane_id, status: agent.agent_status } },
    });
  }
  return sessions;
}

export type TailResult = { updates: SessionUpdate[]; cursor: string; reset?: true; status?: AgentInfo["agent_status"] };

const TAIL_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);
const TAIL_WINDOW_BYTES = 1024 * 1024;

export async function tailSession(
  config: SessionConfig,
  params: { sessionId: string; after?: string; limit: number },
): Promise<TailResult> {
  const { driver } = config;
  const agent = await findTailAgent(config, params.sessionId).catch(() => null);
  const path = await driver.transcriptPath({ sessionId: params.sessionId, cwd: agent?.cwd ?? "", ref: agent?.agent_session ?? null });
  const size = await statSize(path);
  const after = params.after === undefined ? null : Number(params.after);
  const reset = after !== null && after > size;
  const start = after !== null && !reset ? after : Math.max(0, size - TAIL_WINDOW_BYTES);
  const { records, end } = await readCompleteLines(path, start, size);
  const parser = driver.createParser();
  const updates: SessionUpdate[] = [];
  for (const record of driver.replayOrder(records)) {
    const timestamp = (record as { timestamp?: unknown } | null)?.timestamp;
    const meta = typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp)) ? { _meta: { timestamp } } : {};
    for (const event of parser.parse(record, { replay: true })) {
      if (event.type === "update" && TAIL_UPDATES.has(event.update.sessionUpdate)) {
        updates.push({ ...event.update, ...meta } as SessionUpdate);
      }
    }
  }
  return {
    updates: updates.slice(-params.limit),
    cursor: String(end),
    ...(reset ? { reset: true as const } : {}),
    ...(agent ? { status: agent.agent_status } : {}),
  };
}

async function findTailAgent(config: SessionConfig, sessionId: string): Promise<AgentInfo | null> {
  const agents = await config.herdr.listAgents();
  const live = agents.find((agent) => liveSessionId(config, agent) === sessionId);
  if (live) return live;
  const record = await readPaneRecord(config.stateDir, sessionId);
  return (record && agents.find((agent) => agent.pane_id === record.paneId && agent.agent === config.driver.kind)) ?? null;
}

async function statSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function readCompleteLines(path: string, start: number, size: number): Promise<{ records: unknown[]; end: number }> {
  if (size <= start) return { records: [], end: start };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const last = buffer.lastIndexOf(0x0a);
    if (last < 0) return { records: [], end: start };
    const records = buffer
      .subarray(0, last)
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line) as unknown] : [];
        } catch {
          return [];
        }
      });
    return { records, end: start + last + 1 };
  } finally {
    await handle.close();
  }
}

async function findLiveAgent(config: SessionConfig, sessionId: string): Promise<AgentInfo | null> {
  const agents = await config.herdr.listAgents();
  return agents.find((agent) => liveSessionId(config, agent) === sessionId) ?? null;
}

function liveSessionId(config: SessionConfig, agent: AgentInfo): string | null {
  if (agent.agent !== config.driver.kind || !agent.agent_session) return null;
  return config.driver.sessionIdFromRef(agent.agent_session);
}

function placePane(config: SessionConfig, sessionId: string, cwd: string, tabLabel?: string): Promise<Placement> {
  return serialized(async () => {
    const { herdr, workspaceLabel } = config;
    const env = {
      ...config.paneEnv,
      HERDR_ACP_SOCKET: socketPath(config.stateDir, sessionId),
      HERDR_ACP_ENV_FILE: envFilePath(config.stateDir, sessionId),
    };
    const label = tabLabel ?? `${config.driver.kind} ${sessionId.slice(0, 8)}`;
    const workspace = (await herdr.listWorkspaces()).find((ws) => ws.label === workspaceLabel);
    if (!workspace) {
      const created = await herdr.createWorkspace({ label: workspaceLabel, cwd, env });
      await herdr.renameTab(created.tab.tab_id, label);
      return { paneId: created.root_pane.pane_id, tabId: created.tab.tab_id };
    }
    const created = await herdr.createTab({ workspaceId: workspace.workspace_id, label, cwd, env });
    return { paneId: created.root_pane.pane_id, tabId: created.tab.tab_id };
  });
}

export function usageResponse(usage: Map<string, TokenUsage>): Pick<PromptResponse, "usage"> {
  if (usage.size === 0) return {};
  const total = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 };
  for (const item of usage.values()) {
    total.inputTokens += item.inputTokens;
    total.outputTokens += item.outputTokens;
    total.cachedReadTokens += item.cachedReadTokens;
    total.cachedWriteTokens += item.cachedWriteTokens;
    total.thoughtTokens += item.thoughtTokens;
  }
  const totalTokens = total.inputTokens + total.outputTokens + total.cachedReadTokens + total.cachedWriteTokens;
  return { usage: { ...total, totalTokens } };
}
