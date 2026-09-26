import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GLOBAL_HOOK_MARKER } from "../hook-bridge.ts";
import { claudeHookSettings } from "./claude-hooks.ts";

type HookEntry = { matcher?: string; hooks?: { command?: string }[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

export function claudeUserSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

async function readSettings(path: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const backup = `${path}.herdr-acp.bak`;
  const hasFile = await access(path).then(() => true, () => false);
  const hasBackup = await access(backup).then(() => true, () => false);
  if (hasFile && !hasBackup) await copyFile(path, backup);
  const temp = `${path}.herdr-acp.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temp, path);
}

export function withoutHerdrAcpHooks(settings: Settings): Settings {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook) => !hook.command?.includes(GLOBAL_HOOK_MARKER)) }))
      .filter((entry) => entry.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _removed, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export function withHerdrAcpHooks(settings: Settings, command: string): Settings {
  const base = withoutHerdrAcpHooks(settings);
  const hooks: Record<string, HookEntry[]> = { ...(base.hooks ?? {}) };
  for (const [event, entries] of Object.entries(claudeHookSettings(command).hooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...(entries as HookEntry[])];
  }
  return { ...base, hooks };
}

export async function hasGlobalHerdrAcpHooks(path = claudeUserSettingsPath()): Promise<boolean> {
  const settings = await readSettings(path).catch(() => ({}) as Settings);
  return Object.values(settings.hooks ?? {}).some((entries) =>
    entries.some((entry) => (entry.hooks ?? []).some((hook) => hook.command?.includes(GLOBAL_HOOK_MARKER))),
  );
}

export async function installGlobalHooks(command: string, path = claudeUserSettingsPath()): Promise<void> {
  await writeSettings(path, withHerdrAcpHooks(await readSettings(path), command));
}

export async function uninstallGlobalHooks(path = claudeUserSettingsPath()): Promise<void> {
  await writeSettings(path, withoutHerdrAcpHooks(await readSettings(path)));
}
