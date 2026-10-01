import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isInteraction, readSessionPrefs, writeSessionPrefs } from "./session-prefs.ts";

test("remembers the interaction of a session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-acp-prefs-"));
  assert.deepEqual(await readSessionPrefs(dir, "s"), {});
  await writeSessionPrefs(dir, "s", { interaction: "native" });
  assert.deepEqual(await readSessionPrefs(dir, "s"), { interaction: "native" });
  assert.equal(isInteraction("native"), true);
  assert.equal(isInteraction("telepathy"), false);
});
