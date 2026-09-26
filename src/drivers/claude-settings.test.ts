import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasGlobalHerdrAcpHooks, installGlobalHooks, uninstallGlobalHooks } from "./claude-settings.ts";

const command = "node /opt/herdr-acp/dist/hook.js herdr-acp-hook";

test("installs hooks idempotently and restores the original settings on uninstall", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-acp-settings-")), "settings.json");
  const original = {
    model: "opus",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }] },
  };
  await writeFile(path, JSON.stringify(original));

  await installGlobalHooks(command, path);
  await installGlobalHooks(command, path);
  const installed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(await hasGlobalHerdrAcpHooks(path), true);
  assert.equal(installed.model, "opus");
  assert.equal(installed.hooks.PreToolUse.length, 2);
  assert.equal(installed.hooks.PreToolUse[0].hooks[0].command, "my-guard");
  assert.equal(installed.hooks.MessageDisplay.length, 1);
  assert.deepEqual(JSON.parse(await readFile(`${path}.herdr-acp.bak`, "utf8")), original);

  await uninstallGlobalHooks(path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
  assert.equal(await hasGlobalHerdrAcpHooks(path), false);
});

test("creates the settings file when it does not exist", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-acp-settings-")), "settings.json");
  await installGlobalHooks(command, path);
  assert.equal(await hasGlobalHerdrAcpHooks(path), true);
  await uninstallGlobalHooks(path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
});
