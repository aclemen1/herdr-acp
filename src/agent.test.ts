import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

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
  assert.deepEqual(Object.keys(claude.herdr.extensions).sort(), ["permissionSuggestions", "rateLimits", "sessionPlacement"]);
  const pi = (await initialize(["--agent", "pi"]))._meta as { herdr: { agent: string; extensions: Record<string, number> } };
  assert.equal(pi.herdr.agent, "pi");
  assert.deepEqual(Object.keys(pi.herdr.extensions).sort(), ["sessionPlacement"]);
});
