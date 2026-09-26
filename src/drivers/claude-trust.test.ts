import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isClaudeFolderTrusted } from "./claude-trust.ts";

test("inherits trust from an ancestor directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-acp-trust-")));
  const child = join(root, "a", "b");
  await mkdir(child, { recursive: true });
  const config = join(root, "claude.json");
  await writeFile(config, JSON.stringify({ projects: { [join(root, "a")]: { hasTrustDialogAccepted: true } } }));
  assert.equal(await isClaudeFolderTrusted(child, config), true);
  assert.equal(await isClaudeFolderTrusted(root, config), false);
});

test("treats a missing config as untrusted", async () => {
  assert.equal(await isClaudeFolderTrusted(tmpdir(), join(tmpdir(), "does-not-exist.json")), false);
});
