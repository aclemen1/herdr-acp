import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PaneRecord = {
  sessionId: string;
  kind: string;
  target: string;
  paneId: string;
  tabId: string;
  cwd: string;
  updatedAt: string;
};

function recordsDir(stateDir: string): string {
  return join(stateDir, "panes");
}

function recordPath(stateDir: string, sessionId: string): string {
  return join(recordsDir(stateDir), `${sessionId}.json`);
}

export async function writePaneRecord(stateDir: string, record: Omit<PaneRecord, "updatedAt">): Promise<void> {
  await mkdir(recordsDir(stateDir), { recursive: true, mode: 0o700 });
  const path = recordPath(stateDir, record.sessionId);
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temp, path);
}

export async function readPaneRecord(stateDir: string, sessionId: string): Promise<PaneRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(stateDir, sessionId), "utf8")) as PaneRecord;
  } catch {
    return null;
  }
}

export async function deletePaneRecord(stateDir: string, sessionId: string): Promise<void> {
  await rm(recordPath(stateDir, sessionId), { force: true });
}

export async function listPaneRecords(stateDir: string): Promise<PaneRecord[]> {
  const names = await readdir(recordsDir(stateDir)).catch(() => [] as string[]);
  const records = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readPaneRecord(stateDir, name.slice(0, -".json".length))),
  );
  return records.filter((record): record is PaneRecord => record !== null);
}
