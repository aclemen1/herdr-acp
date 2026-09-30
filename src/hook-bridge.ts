import { accessSync, constants } from "node:fs";
import { mkdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SOCKET_PATH = 92;

export const GLOBAL_HOOK_MARKER = "herdr-acp-hook";

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "herdr-acp");
}

export function socketPath(stateDir: string, sessionId: string): string {
  const preferred = join(stateDir, "s", `${sessionId}.sock`);
  if (preferred.length <= MAX_SOCKET_PATH) return preferred;
  return join(tmpdir(), `herdr-acp-${process.getuid?.() ?? "u"}`, `${sessionId}.sock`);
}

export function envFilePath(stateDir: string, sessionId: string): string {
  return join(stateDir, "env", `${sessionId}.sh`);
}

export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'\n`)
    .join("");
}

export function hookCommand(options: { global?: boolean } = {}): string {
  const script = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./hook.ts" : "./hook.js", import.meta.url));
  const node = options.global ? (nodeOnPath() ?? process.execPath) : process.execPath;
  const command = `${shellQuote(node)} ${shellQuote(script)}`;
  return options.global ? `${command} ${GLOBAL_HOOK_MARKER}` : command;
}

export function statusLineCommand(): string {
  const script = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./statusline.ts" : "./statusline.js", import.meta.url),
  );
  return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
}

function nodeOnPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export type HookHandler = (input: unknown) => Promise<unknown | null>;

let serverCount = 0;

// The stable path is a symlink to a per-process socket, so a takeover swaps the link atomically and
// closing an old server (libuv unlinks its own socket file) never removes the new owner's socket.
export class HookServer {
  readonly path: string;
  private readonly server: Server;
  private readonly boundPath: string;

  private constructor(path: string, server: Server, boundPath: string) {
    this.path = path;
    this.server = server;
    this.boundPath = boundPath;
  }

  static async listen(path: string, handler: HookHandler): Promise<HookServer> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const boundPath = `${path}.${process.pid}-${++serverCount}`;
    await unlink(boundPath).catch(() => undefined);
    const server = createServer((socket) => serve(socket, handler));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(boundPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const link = `${boundPath}.link`;
    await unlink(link).catch(() => undefined);
    await symlink(basename(boundPath), link);
    await rename(link, path);
    return new HookServer(path, server, boundPath);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.boundPath).catch(() => undefined);
    const target = await readlink(this.path).catch(() => null);
    if (target === basename(this.boundPath)) await unlink(this.path).catch(() => undefined);
  }
}

function serve(socket: Socket, handler: HookHandler): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = "";
    void respond(socket, handler, line);
  });
}

async function respond(socket: Socket, handler: HookHandler, line: string): Promise<void> {
  let output: unknown = null;
  try {
    const { input } = JSON.parse(line) as { input: unknown };
    output = await handler(input);
  } catch (error) {
    process.stderr.write(`herdr-acp: hook handler failed: ${String(error)}\n`);
  }
  socket.end(`${JSON.stringify({ output })}\n`);
}
