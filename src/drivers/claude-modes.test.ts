import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeInitialMode, claudeModes, modeAllowsTool, withoutPermissionModeArg } from "./claude-modes.ts";

test("offers bypass only when Claude was allowed to skip permissions", () => {
  assert.equal(claudeModes([]).some((mode) => mode.id === "bypassPermissions"), false);
  assert.equal(claudeModes(["--allow-dangerously-skip-permissions"]).some((mode) => mode.id === "bypassPermissions"), true);
});

test("reads the initial mode from arguments, then from user settings", async () => {
  const settings = join(await mkdtemp(join(tmpdir(), "herdr-acp-modes-")), "settings.json");
  await writeFile(settings, JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
  assert.equal(await claudeInitialMode(["--permission-mode", "plan"], settings), "plan");
  assert.equal(await claudeInitialMode([], settings), "acceptEdits");
  assert.equal(await claudeInitialMode([], join(tmpdir(), "missing-settings.json")), "default");
});

test("replaces a permission mode argument", () => {
  assert.deepEqual(withoutPermissionModeArg(["--model", "opus", "--permission-mode", "plan", "--permission-mode=default"]), [
    "--model",
    "opus",
  ]);
});

test("knows which tools a mode approves", () => {
  assert.equal(modeAllowsTool("acceptEdits", "Edit"), true);
  assert.equal(modeAllowsTool("acceptEdits", "Bash"), false);
  assert.equal(modeAllowsTool("bypassPermissions", "Bash"), true);
  assert.equal(modeAllowsTool("default", "Edit"), false);
});
