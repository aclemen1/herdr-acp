import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

type RegistryEntry = { pid: string; sessionId?: string; messagingSocketPath?: string; peerProtocol?: number; updatedAt?: number };

export function claudeSessionsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
}

// Undocumented Claude Code inbox: socket listed in <pid>.json, peerToken in <pid>.<hash>.key.
export async function deliverToInbox(sessionId: string, text: string, dir = claudeSessionsDir()): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as Omit<RegistryEntry, "pid">;
      if (entry.sessionId === sessionId && entry.messagingSocketPath && entry.peerProtocol === 1) {
        entries.push({ ...entry, pid: name.slice(0, -5) });
      }
    } catch {}
  }
  entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const entry of entries) {
    const token = await peerToken(dir, names, entry.pid);
    if (token && (await send(entry.messagingSocketPath!, token, text))) return true;
  }
  return false;
}

export function isQueuedPrompt(record: unknown, text: string): boolean {
  const rec = record as { type?: string; operation?: string; content?: unknown } | null;
  return (
    rec?.type === "queue-operation" &&
    rec.operation === "enqueue" &&
    typeof rec.content === "string" &&
    rec.content.trim() === text.trim()
  );
}

const PEER_FRAME = /^Another Claude session sent a message:\n([\s\S]*?)\n\nThis came from another Claude session\b/;

export function peerMessageBody(content: string): string {
  return PEER_FRAME.exec(content)?.[1] ?? content;
}

async function peerToken(dir: string, names: string[], pid: string): Promise<string | null> {
  const keyFile = names.find((name) => name.startsWith(`${pid}.`) && name.endsWith(".key"));
  if (!keyFile) return null;
  try {
    const { peerToken } = JSON.parse(await readFile(join(dir, keyFile), "utf8")) as { peerToken?: unknown };
    return typeof peerToken === "string" ? peerToken : null;
  } catch {
    return null;
  }
}

function send(socketPath: string, token: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.setTimeout(2_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "auth", token })}\n`);
      socket.end(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`, () => resolve(true));
    });
    socket.resume();
  });
}
