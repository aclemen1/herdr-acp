#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { defaultStateDir, envFilePath, socketPath } from "./hook-bridge.ts";

const raw = readFileSync(0, "utf8");
if (!raw.trim()) process.exit(0);
const input = JSON.parse(raw) as { session_id?: string; hook_event_name?: string };
const stateDir = defaultStateDir();
const localOutput = applySessionEnv();
const path = process.env.HERDR_ACP_SOCKET ?? (input.session_id ? socketPath(stateDir, input.session_id) : undefined);
if (!path || !existsSync(path)) finish(null);

const socket = connect(path!);
let reply = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify({ input })}\n`));
socket.on("data", (chunk: string) => {
  reply += chunk;
});
socket.on("error", () => finish(null));
socket.on("close", () => {
  try {
    finish((JSON.parse(reply) as { output: unknown }).output);
  } catch {
    finish(null);
  }
});

function applySessionEnv(): unknown {
  const event = input.hook_event_name;
  if (event !== "SessionStart" && event !== "FileChanged" && event !== "CwdChanged") return null;
  const envFile = process.env.HERDR_ACP_ENV_FILE ?? (input.session_id ? envFilePath(stateDir, input.session_id) : undefined);
  if (!envFile || !existsSync(envFile)) return null;
  const target = process.env.CLAUDE_ENV_FILE;
  if (target) writeFileSync(target, readFileSync(envFile, "utf8"));
  return { hookSpecificOutput: { hookEventName: event, watchPaths: [envFile] } };
}

function finish(output: unknown): never {
  const result = output ?? localOutput;
  if (result !== null && result !== undefined) process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
