import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deletePaneRecord, listPaneRecords, readPaneRecord, writePaneRecord } from "./pane-records.ts";

test("stores, lists and deletes pane records per session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-acp-records-"));
  const record = { sessionId: "s1", kind: "claude", target: "default@local", paneId: "w1:p2", tabId: "w1:t2", cwd: "/work" };
  await writePaneRecord(dir, record);
  const read = await readPaneRecord(dir, "s1");
  assert.equal(read?.paneId, "w1:p2");
  assert.ok(read?.updatedAt);
  assert.deepEqual((await listPaneRecords(dir)).map((item) => item.sessionId), ["s1"]);
  await deletePaneRecord(dir, "s1");
  assert.equal(await readPaneRecord(dir, "s1"), null);
  assert.deepEqual(await listPaneRecords(dir), []);
});
