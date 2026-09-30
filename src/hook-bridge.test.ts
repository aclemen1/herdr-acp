import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HookServer, renderEnvFile, socketPath } from "./hook-bridge.ts";

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

test("renders shell exports with safe quoting", () => {
  assert.equal(renderEnvFile({ A: "x", B: "it's", "BAD-NAME": "no" }), "export A='x'\nexport B='it'\\''s'\n");
});

test("copies the session env into Claude's env file on SessionStart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hacp-env-"));
  const envFile = join(dir, "session.sh");
  const claudeEnvFile = join(dir, "claude-env.sh");
  await writeFile(envFile, "export PAPERCLIP_RUN_ID='r2'\n");
  const result = await new Promise<{ stdout: string; code: number | null }>((resolve) => {
    const proc = spawn(process.execPath, [hookScript], {
      env: { ...process.env, HERDR_ACP_SOCKET: join(dir, "missing.sock"), HERDR_ACP_ENV_FILE: envFile, CLAUDE_ENV_FILE: claudeEnvFile },
    });
    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.on("close", (code) => resolve({ stdout, code }));
    proc.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }));
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "SessionStart", watchPaths: [envFile] } });
  assert.equal(await readFile(claudeEnvFile, "utf8"), "export PAPERCLIP_RUN_ID='r2'\n");
});

test("keeps watching the session env after a directory change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hacp-env-"));
  const envFile = join(dir, "session.sh");
  await writeFile(envFile, "export A='1'\n");
  const stdout = await new Promise<string>((resolve) => {
    const proc = spawn(process.execPath, [hookScript], {
      env: { ...process.env, HERDR_ACP_SOCKET: join(dir, "missing.sock"), HERDR_ACP_ENV_FILE: envFile, CLAUDE_ENV_FILE: join(dir, "c.sh") },
    });
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.on("close", () => resolve(out));
    proc.stdin.end(JSON.stringify({ hook_event_name: "CwdChanged", session_id: "s" }));
  });
  assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: "CwdChanged", watchPaths: [envFile] } });
});

test("a closing server leaves a socket that another server took over", async () => {
  const path = socketPath(await mkdtemp(join(tmpdir(), "hacp-")), "shared");
  const first = await HookServer.listen(path, async () => "first");
  const second = await HookServer.listen(path, async () => ({ from: "second" }));
  await first.close();
  const result = await runHook(path, { hook_event_name: "PreToolUse" });
  assert.deepEqual(JSON.parse(result.stdout), { from: "second" });
  await second.close();
});
