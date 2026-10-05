import type {
  CreateElicitationResponse,
  ElicitationSchema,
  McpServer,
  PermissionOption,
  SessionConfigOption,
  SessionMode,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSessionRef } from "../herdr.ts";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
};

export type DriverEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "usage"; messageId: string; usage: TokenUsage }
  | { type: "stop_reason"; stopReason: StopReason }
  | { type: "turn_end" }
  | { type: "queue"; change: "enqueue" | "dequeue" | "clear"; content?: string };

export interface TranscriptParser {
  parse(record: unknown, options: { replay: boolean; since?: number }): DriverEvent[];
  markAnnounced(toolCallId: string): void;
  markSettled(toolCallId: string): void;
}

export type SessionSettings = { mode: string; model: string; effort: string | null };

export type StatusReport = {
  contextUsed?: number;
  contextSize?: number;
  modelId?: string;
  modelLabel?: string;
  effort?: string;
  rateLimits?: Record<string, unknown>;
};

export type LaunchInput = {
  sessionId: string;
  resume: boolean;
  cwd: string;
  mcpServers: McpServer[];
  stateDir: string;
  extraArgs: string[];
  hookCommand: string;
  statusLineCommand: string;
  clientCanElicit: boolean;
  trustApproved: boolean;
  interaction: "client" | "native";
  mode?: string;
  model?: string;
  effort?: string;
  forkFrom?: string;
};

export interface HookHost {
  readonly sessionId: string;
  readonly cwd: string;
  notify(update: SessionUpdate): Promise<void>;
  announceToolCall(toolCallId: string): void;
  settleToolCall(toolCallId: string): void;
  streamText(text: string, kind?: "message" | "thought"): Promise<void>;
  currentMode(): string;
  interaction(): "client" | "native";
  endTurn(): void;
  requestPermission(toolCall: ToolCallUpdate, options: PermissionOption[]): Promise<string | null>;
  availableModeIds(): string[];
  reportMode(modeId: string): Promise<void>;
  reportStatus(status: StatusReport): Promise<void>;
  takePendingMode(): string | null;
  restorePendingMode(modeId: string): void;
  continueWithMode(modeId: string, prompt: string): void;
  elicit(request: { message: string; schema: ElicitationSchema; toolCallId?: string }): Promise<CreateElicitationResponse | null>;
  markCancelled(): void;
  envApplied(): void;
}

export type HookHandler = (input: unknown) => Promise<unknown | null>;

export interface Driver {
  readonly kind: string;
  readonly title: string;
  newSessionId(): string;
  sessionIdFromRef(ref: AgentSessionRef): string | null;
  launchArgs(input: LaunchInput): Promise<string[]>;
  transcriptPath(input: { sessionId: string; cwd: string; ref: AgentSessionRef | null }): Promise<string>;
  transcriptExists(sessionId: string): Promise<boolean>;
  listTranscripts(cwd: string): Promise<{ sessionId: string; title: string | null; updatedAt: string }[]>;
  createParser(): TranscriptParser;
  createHookHandler(host: HookHost): HookHandler;
  isFolderTrusted(cwd: string): Promise<boolean>;
  readonly acceptTrustKeys: string[];
  installGlobalHooks(command: string): Promise<string>;
  uninstallGlobalHooks(): Promise<string>;
  availableModes(extraArgs: string[]): SessionMode[];
  initialSettings(extraArgs: string[]): Promise<SessionSettings>;
  configOptions(settings: SessionSettings, modes: SessionMode[], modelLabel: string | null): SessionConfigOption[];
  readonly protectedEnv: RegExp;
  readonly exitCommand: string;
  readonly modeRequiresRestart: boolean;
  readonly extensions: Record<string, number>;
  readonly envAcknowledged: boolean;
  replayOrder(records: unknown[]): unknown[];
  launchedByHerdrAcp(argvs: string[][], input: { sessionId: string; stateDir: string }): Promise<boolean>;
  deliverQueued?(sessionId: string, text: string): Promise<boolean>;
  confirmsQueued?(record: unknown, text: string): boolean;
}
