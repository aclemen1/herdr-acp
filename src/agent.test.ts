import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

function exchange(args: string[], requests: object[], id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [entry, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n").find((item) => item.includes(`"id":${id}`));
      if (line) {
        proc.kill();
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });
    proc.on("error", reject);
    for (const request of requests) proc.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function initialize(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [entry, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n").find((item) => item.includes('"id":1'));
      if (line) {
        proc.kill();
        resolve((JSON.parse(line) as { result: Record<string, unknown> }).result);
      }
    });
    proc.on("error", reject);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
  });
}

test("announces herdr extensions per agent at initialize", async () => {
  const claude = (await initialize([]))._meta as { herdr: { agent: string; extensions: Record<string, number> } };
  assert.equal(claude.herdr.agent, "claude");
  assert.deepEqual(Object.keys(claude.herdr.extensions).sort(), ["delivery", "interaction", "permissionSuggestions", "rateLimits", "sessionConfig", "sessionOwnership", "sessionPlacement", "tabLabel"]);
  const pi = (await initialize(["--agent", "pi"]))._meta as { herdr: { agent: string; extensions: Record<string, number> } };
  assert.equal(pi.herdr.agent, "pi");
  assert.deepEqual(Object.keys(pi.herdr.extensions).sort(), ["interaction", "sessionConfig", "sessionOwnership", "sessionPlacement", "tabLabel"]);
});

test("rejects an unknown interaction before creating anything", async () => {
  const reply = await exchange(
    [],
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [], _meta: { herdr: { interaction: "telepathy" } } } },
    ],
    2,
  );
  const error = reply.error as { code: number; message: string };
  assert.equal(error.code, -32602);
  assert.match(error.message, /unsupported interaction: telepathy/);
});

test("rejects an unknown prompt delivery", async () => {
  const reply = await exchange(
    [],
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "x", prompt: [{ type: "text", text: "hi" }], _meta: { delivery: "later" } } },
    ],
    2,
  );
  const error = reply.error as { code: number; message: string };
  assert.equal(error.code, -32602);
  assert.match(error.message, /unsupported delivery: later/);
});

test("rejects a multi-line tab label before creating anything", async () => {
  const reply = await exchange(
    [],
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [], _meta: { herdr: { tabLabel: "a\nb" } } } },
    ],
    2,
  );
  assert.equal((reply.error as { code: number }).code, -32602);
});
