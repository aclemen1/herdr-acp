#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { defaultStateDir, socketPath } from "./hook-bridge.ts";

const raw = readFileSync(0, "utf8");
const original = process.argv[2] ? Buffer.from(process.argv[2], "base64url").toString("utf8") : "";

function forward(): Promise<void> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Promise.resolve();
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  const path = process.env.HERDR_ACP_SOCKET ?? (sessionId ? socketPath(defaultStateDir(), sessionId) : undefined);
  if (!path || !existsSync(path)) return Promise.resolve();
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = () => {
      socket.destroy();
      resolve();
    };
    socket.setTimeout(1000, done);
    socket.on("connect", () => socket.write(`${JSON.stringify({ input: { ...input, hook_event_name: "StatusLine" } })}\n`));
    socket.on("data", done);
    socket.on("error", done);
    socket.on("close", done);
  });
}

function runOriginal(): Promise<number> {
  if (!original) return Promise.resolve(0);
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", original], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin.end(raw);
  });
}

const [, code] = await Promise.all([forward(), runOriginal()]);
process.exit(code);
