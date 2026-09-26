#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { connect } from "node:net";

const path = process.env.HERDR_ACP_SOCKET;
const raw = readFileSync(0, "utf8");
if (!path || !raw.trim()) process.exit(0);

const socket = connect(path);
let reply = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify({ input: JSON.parse(raw) })}\n`));
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
