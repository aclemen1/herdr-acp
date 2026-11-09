import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
}

export async function isClaudeFolderTrusted(cwd: string, configPath = claudeGlobalConfigPath()): Promise<boolean> {
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
  try {
    projects = (JSON.parse(await readFile(configPath, "utf8")) as { projects?: typeof projects }).projects ?? {};
  } catch {
    return false;
  }
  const starts = new Set([resolve(cwd), await realpath(cwd).catch(() => resolve(cwd))]);
  for (const start of starts) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (projects[dir]?.hasTrustDialogAccepted || projects[dir.normalize("NFC")]?.hasTrustDialogAccepted) return true;
      // Claude Code does not inherit trust from above the root of a git repository.
      if (dirname(dir) === dir || (await exists(join(dir, ".git")))) break;
    }
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
