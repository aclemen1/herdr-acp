import { execFile } from "node:child_process";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type AgentSessionRef = {
  agent: string;
  kind: "id" | "path";
  source: string;
  value: string;
};

export type AgentInfo = {
  agent: string;
  name?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSessionRef | null;
  cwd?: string;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  launch_pending?: boolean | null;
  terminal_title_stripped?: string;
};

export type PaneInfo = { pane_id: string; tab_id: string; workspace_id: string };
export type TabInfo = { tab_id: string; workspace_id: string; label: string; pane_count?: number };
export type WorkspaceInfo = { workspace_id: string; label: string };

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export type HerdrOptions = {
  bin?: string;
  session?: string;
  machine?: string;
};

type Envelope<T> = { result?: T; error?: { code: string; message: string } };

export class Herdr {
  private readonly bin: string;
  private readonly globalArgs: string[];
  readonly target: string;

  constructor(options: HerdrOptions = {}) {
    this.bin = options.bin ?? "herdr";
    this.target = `${options.session ?? "default"}@${options.machine ?? "local"}`;
    this.globalArgs = [
      ...(options.session ? ["--session", options.session] : []),
      ...(options.machine ? ["--machine", options.machine] : []),
    ];
  }

  async call<T>(args: string[]): Promise<T> {
    const { stdout, stderr, code } = await run(this.bin, [...this.globalArgs, ...args]);
    const envelope = parseEnvelope<T>(code === 0 ? stdout : stderr || stdout);
    if (envelope?.error) throw new HerdrError(envelope.error.code, envelope.error.message);
    if (code !== 0 || !envelope || envelope.result === undefined) {
      throw new HerdrError("cli_failed", `herdr ${args.join(" ")} failed (exit ${code}): ${(stderr || stdout).trim()}`);
    }
    return envelope.result;
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    return (await this.call<{ workspaces: WorkspaceInfo[] }>(["workspace", "list"])).workspaces;
  }

  async createWorkspace(opts: { label: string; cwd: string; env: Record<string, string> }) {
    return this.call<{ workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }>([
      "workspace", "create", "--label", opts.label, "--cwd", opts.cwd, ...envArgs(opts.env), "--no-focus",
    ]);
  }

  async createTab(opts: { workspaceId: string; label: string; cwd: string; env: Record<string, string> }) {
    return this.call<{ tab: TabInfo; root_pane: PaneInfo }>([
      "tab", "create", "--workspace", opts.workspaceId, "--label", opts.label, "--cwd", opts.cwd,
      ...envArgs(opts.env), "--no-focus",
    ]);
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.call(["tab", "rename", tabId, label]);
  }

  async getTab(tabId: string): Promise<TabInfo | null> {
    try {
      return (await this.call<{ tab: TabInfo }>(["tab", "get", tabId])).tab;
    } catch (error) {
      if (error instanceof HerdrError) return null;
      throw error;
    }
  }

  async closePane(paneId: string): Promise<void> {
    await this.call(["pane", "close", paneId]);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.call(["tab", "close", tabId]);
  }

  async listAgents(): Promise<AgentInfo[]> {
    return (await this.call<{ agents: AgentInfo[] }>(["agent", "list"])).agents;
  }

  async getPane(paneId: string): Promise<PaneInfo | null> {
    try {
      return (await this.call<{ pane: PaneInfo }>(["pane", "get", paneId])).pane;
    } catch (error) {
      if (error instanceof HerdrError) return null;
      throw error;
    }
  }

  async getAgent(target: string): Promise<AgentInfo> {
    return (await this.call<{ agent: AgentInfo }>(["agent", "get", target])).agent;
  }

  async startAgent(opts: { name: string; kind: string; paneId: string; args: string[]; timeoutMs: number }) {
    return (
      await this.call<{ agent: AgentInfo }>([
        "agent", "start", opts.name, "--kind", opts.kind, "--pane", opts.paneId,
        "--timeout", String(opts.timeoutMs), "--", ...opts.args,
      ])
    ).agent;
  }

  async prompt(target: string, text: string): Promise<void> {
    await this.call(["agent", "prompt", target, text]);
  }

  async sendKeys(target: string, keys: string[]): Promise<void> {
    await this.call(["agent", "send-keys", target, ...keys]);
  }
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function parseEnvelope<T>(text: string): Envelope<T> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Envelope<T>;
  } catch {
    return null;
  }
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: error ? Number(error.code) : 0 });
    });
  });
}
