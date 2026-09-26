import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HookServer, socketPath } from "./hook-bridge.ts";

const hookScript = fileURLToPath(new URL("./hook.ts", import.meta.url));

function runHook(socket: string, input: unknown): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [hookScript], { env: { ...process.env, HERDR_ACP_SOCKET: socket } });
    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.on("close", (code) => resolve({ stdout, code }));
    proc.stdin.end(JSON.stringify(input));
  });
}

test("relays a hook input to the session server and prints its output", async () => {
  const path = socketPath(await mkdtemp(join(tmpdir(), "hacp-")), "session-1");
  const seen: unknown[] = [];
  const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  const server = await HookServer.listen(path, async (input) => {
    seen.push(input);
    return decision;
  });
  try {
    const result = await runHook(path, { hook_event_name: "PreToolUse" });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), decision);
    assert.deepEqual(seen, [{ hook_event_name: "PreToolUse" }]);
  } finally {
    await server.close();
  }
});

test("prints nothing when no session server is listening", async () => {
  const result = await runHook(join(tmpdir(), "herdr-acp-missing.sock"), { hook_event_name: "PreToolUse" });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});
