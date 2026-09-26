import { readFile } from "node:fs/promises";
import type { SessionMode } from "@agentclientprotocol/sdk";
import { claudeUserSettingsPath } from "./claude-settings.ts";

const MODES: SessionMode[] = [
  { id: "default", name: "Default", description: "Ask before edits and commands" },
  { id: "acceptEdits", name: "Accept edits", description: "Edit files without asking" },
  { id: "plan", name: "Plan", description: "Explore and plan without making changes" },
  { id: "dontAsk", name: "Don't ask", description: "Deny every tool call that is not pre-approved" },
];

const BYPASS: SessionMode = { id: "bypassPermissions", name: "Bypass permissions", description: "Run every tool without asking" };

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function claudeModes(extraArgs: string[]): SessionMode[] {
  const bypass = extraArgs.some((arg) => arg === "--dangerously-skip-permissions" || arg === "--allow-dangerously-skip-permissions");
  return bypass ? [...MODES, BYPASS] : MODES;
}

export function permissionModeArg(extraArgs: string[]): string | undefined {
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    if (arg === "--permission-mode") return extraArgs[i + 1];
    if (arg.startsWith("--permission-mode=")) return arg.slice("--permission-mode=".length);
    if (arg === "--dangerously-skip-permissions") return "bypassPermissions";
  }
  return undefined;
}

export function withoutPermissionModeArg(extraArgs: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    if (arg === "--permission-mode") i++;
    else if (!arg.startsWith("--permission-mode=")) rest.push(arg);
  }
  return rest;
}

export async function claudeInitialMode(extraArgs: string[], settingsPath = claudeUserSettingsPath()): Promise<string> {
  const fromArgs = permissionModeArg(extraArgs);
  if (fromArgs) return fromArgs;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { permissions?: { defaultMode?: string } };
    return settings.permissions?.defaultMode ?? "default";
  } catch {
    return "default";
  }
}

export function modeAllowsTool(mode: string, toolName: string): boolean {
  if (mode === "bypassPermissions") return true;
  if (mode === "acceptEdits") return EDIT_TOOLS.has(toolName);
  return false;
}
