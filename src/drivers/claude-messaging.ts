import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const ENVELOPE = "cross-session-message";

type RegistryEntry = { pid: string; sessionId?: string; messagingSocketPath?: string; peerProtocol?: number; updatedAt?: number };

export function claudeSessionsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
}

// Undocumented Claude Code inbox: socket listed in <pid>.json, peerToken in <pid>.<hash>.key.
export type PeerMode = "bypass" | "prompting";

// Claude Code's class: plan counts as bypass when bypass is available.
export function peerModeOf(mode: string, bypassAvailable: boolean): PeerMode {
  return mode === "bypassPermissions" || (mode === "plan" && bypassAvailable) ? "bypass" : "prompting";
}

// The receiving session holds an inbox message whose sender attests no
// permission class, or another class, when it bypasses prompts.
export function peerEnvelope(text: string, fromMode?: PeerMode): string {
  if (!fromMode) return text;
  return `<${ENVELOPE} from-name="herdr-acp" from-mode="${fromMode}">\n${text}\n</${ENVELOPE}>`;
}

export function deliverToInbox(sessionId: string, text: string, fromMode?: PeerMode, dir = claudeSessionsDir()): Promise<boolean> {
  return deliverRaw(sessionId, peerEnvelope(text, fromMode), dir);
}

async function deliverRaw(sessionId: string, text: string, dir: string): Promise<boolean> {
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

// The inbox's message is confirmed by its enqueue record when the session is
// busy, or by the user record it becomes at once when the session is idle:
// missing the latter, the prompt was typed a second time. An inbox enqueue
// record may carry no content (a session busy compacting writes none); a
// prompt typed in the TUI always carries its text.
export function isQueuedPrompt(record: unknown, text: string): boolean {
  const rec = record as {
    type?: string;
    operation?: string;
    content?: unknown;
    message?: { role?: string; content?: unknown };
  } | null;
  if (rec?.type === "queue-operation") {
    if (rec.operation !== "enqueue") return false;
    return rec.content === undefined || (typeof rec.content === "string" && peerMessageBody(rec.content).trim() === text.trim());
  }
  if (rec?.type === "user" && typeof rec.message?.content === "string") {
    const content = rec.message.content;
    return content !== peerMessageBody(content) && peerMessageBody(content).trim() === text.trim();
  }
  return false;
}

// A held inbox message leaves a system record with the sender's claimed name
// and a preview of the body's first line, scrubbed of brackets and quotes.
export function isHeldPrompt(record: unknown, text: string): boolean {
  const rec = record as { type?: string; content?: unknown } | null;
  if (rec?.type !== "system" || typeof rec.content !== "string") return false;
  if (!rec.content.startsWith("Held peer message") || !rec.content.includes("(peer claims name: herdr-acp)")) return false;
  const preview = /preview: \u00ab([^\u00bb]*)\u00bb/.exec(rec.content)?.[1];
  if (preview === undefined) return true;
  const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const letters = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");
  return letters(firstLine).startsWith(letters(preview));
}

const PEER_FRAME = /^Another Claude session sent a message:\n([\s\S]*?)\n\nThis came from another Claude session\b/;
const PEER_ENVELOPE = new RegExp(`^<${ENVELOPE}(?: [a-z-]+="[^"<>\\n\\r]*")*>\\n([\\s\\S]*)\\n</${ENVELOPE}>$`);

export function peerMessageBody(content: string): string {
  const body = PEER_FRAME.exec(content)?.[1] ?? content;
  return PEER_ENVELOPE.exec(body.trim())?.[1] ?? body;
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
