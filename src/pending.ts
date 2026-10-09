import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PendingKind = "permission" | "question";
export type Pending = { kind: PendingKind; title: string; since: string };
type Stored = Pending & { pid: number; token: string };

const MAX_TITLE = 200;

function pendingPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "pending", `${sessionId}.json`);
}

export async function markPending(
  stateDir: string,
  sessionId: string,
  pending: { kind: PendingKind; title: string },
): Promise<() => Promise<void>> {
  const path = pendingPath(stateDir, sessionId);
  const token = randomUUID();
  const title = pending.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const stored: Stored = { kind: pending.kind, title, since: new Date().toISOString(), pid: process.pid, token };
  try {
    await mkdir(join(stateDir, "pending"), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(stored), { mode: 0o600 });
  } catch {
    return async () => {};
  }
  return async () => {
    const current = await readStored(path);
    if (current?.token === token) await rm(path, { force: true }).catch(() => undefined);
  };
}

export async function readPending(stateDir: string, sessionId: string): Promise<Pending | null> {
  const stored = await readStored(pendingPath(stateDir, sessionId));
  if (!stored || !isAlive(stored.pid)) return null;
  return { kind: stored.kind, title: stored.title, since: stored.since };
}

async function readStored(path: string): Promise<Stored | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Stored;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
