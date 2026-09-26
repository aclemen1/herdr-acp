#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { defaultStateDir, socketPath } from "./hook-bridge.ts";

const raw = readFileSync(0, "utf8");
if (!raw.trim()) process.exit(0);
const input = JSON.parse(raw) as { session_id?: string };
const path =
  process.env.HERDR_ACP_SOCKET ?? (input.session_id ? socketPath(defaultStateDir(), input.session_id) : undefined);
if (!path || !existsSync(path)) process.exit(0);

const socket = connect(path);
let reply = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify({ input })}\n`));
socket.on("data", (chunk: string) => {
  reply += chunk;
});
socket.on("error", () => process.exit(0));
socket.on("close", () => {
  try {
    const { output } = JSON.parse(reply) as { output: unknown };
    if (output !== null && output !== undefined) process.stdout.write(JSON.stringify(output));
  } catch {}
  process.exit(0);
});
