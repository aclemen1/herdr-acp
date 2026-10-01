import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const INTERACTIONS = ["client", "native"] as const;
export type Interaction = (typeof INTERACTIONS)[number];

export type SessionPrefs = { interaction?: Interaction };

function prefsPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "prefs", `${sessionId}.json`);
}

export async function readSessionPrefs(stateDir: string, sessionId: string): Promise<SessionPrefs> {
  try {
    return JSON.parse(await readFile(prefsPath(stateDir, sessionId), "utf8")) as SessionPrefs;
  } catch {
    return {};
  }
}

export async function writeSessionPrefs(stateDir: string, sessionId: string, prefs: SessionPrefs): Promise<void> {
  await mkdir(join(stateDir, "prefs"), { recursive: true, mode: 0o700 });
  const path = prefsPath(stateDir, sessionId);
  await writeFile(`${path}.tmp`, JSON.stringify(prefs), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export function isInteraction(value: unknown): value is Interaction {
  return typeof value === "string" && (INTERACTIONS as readonly string[]).includes(value);
}
