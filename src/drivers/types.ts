import type {
  CreateElicitationResponse,
  ElicitationSchema,
  McpServer,
  PermissionOption,
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
  | { type: "turn_end" };

export interface TranscriptParser {
  parse(record: unknown, options: { replay: boolean }): DriverEvent[];
  markAnnounced(toolCallId: string): void;
}

export type LaunchInput = {
  sessionId: string;
  resume: boolean;
  cwd: string;
  mcpServers: McpServer[];
  stateDir: string;
  extraArgs: string[];
  hookCommand: string;
};

export interface HookHost {
  readonly sessionId: string;
  notify(update: SessionUpdate): Promise<void>;
  announceToolCall(toolCallId: string): void;
  streamText(text: string): Promise<void>;
  requestPermission(toolCall: ToolCallUpdate, options: PermissionOption[]): Promise<string | null>;
  elicit(request: { message: string; schema: ElicitationSchema; toolCallId?: string }): Promise<CreateElicitationResponse | null>;
  markCancelled(): void;
}

export type HookHandler = (input: unknown) => Promise<unknown | null>;

export interface Driver {
  readonly kind: string;
  readonly title: string;
  newSessionId(): string;
  launchArgs(input: LaunchInput): Promise<string[]>;
  transcriptPath(input: { sessionId: string; cwd: string; ref: AgentSessionRef | null }): Promise<string>;
  transcriptExists(sessionId: string): Promise<boolean>;
  createParser(): TranscriptParser;
  createHookHandler(host: HookHost): HookHandler;
  isFolderTrusted(cwd: string): Promise<boolean>;
  readonly acceptTrustKeys: string[];
}
