import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";

export const SESSION_OWNED_ERROR = -32010;

export type Owner = { pid: number; since: string };

function ownerPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "owners", `${sessionId}.json`);
}

export async function readOwner(stateDir: string, sessionId: string): Promise<Owner | null> {
  try {
    return JSON.parse(await readFile(ownerPath(stateDir, sessionId), "utf8")) as Owner;
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

export function sessionOwnedError(sessionId: string, owner: Owner, message = "session is owned by another herdr-acp process") {
  return new RequestError(SESSION_OWNED_ERROR, message, {
    sessionId,
    ownerPid: owner.pid,
    ownerSince: owner.since,
    takeover: "_meta.herdr.takeover",
  });
}

export async function acquireOwnership(stateDir: string, sessionId: string, takeover: boolean): Promise<Owner> {
  const current = await readOwner(stateDir, sessionId);
  if (current && current.pid !== process.pid && isAlive(current.pid) && !takeover) {
    throw sessionOwnedError(sessionId, current);
  }
  const path = ownerPath(stateDir, sessionId);
  await mkdir(join(stateDir, "owners"), { recursive: true, mode: 0o700 });
  const owner: Owner = { pid: process.pid, since: new Date().toISOString() };
  await writeFile(`${path}.tmp`, JSON.stringify(owner), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return owner;
}

function isToken(current: Owner | null, token: Owner): boolean {
  return current?.pid === token.pid && current.since === token.since;
}

export async function checkOwnership(stateDir: string, sessionId: string, token: Owner): Promise<void> {
  const current = await readOwner(stateDir, sessionId);
  if (!isToken(current, token)) {
    throw sessionOwnedError(sessionId, current ?? { pid: 0, since: "" }, "session was taken over by another herdr-acp process");
  }
}

export async function releaseOwnership(stateDir: string, sessionId: string, token: Owner): Promise<void> {
  if (isToken(await readOwner(stateDir, sessionId), token)) await rm(ownerPath(stateDir, sessionId), { force: true });
}
