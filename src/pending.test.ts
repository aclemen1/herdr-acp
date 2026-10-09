import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markPending, readPending } from "./pending.ts";

const stateDir = () => mkdtempSync(join(tmpdir(), "herdr-acp-pending-"));

test("reports a pending request until it is cleared", async () => {
  const dir = stateDir();
  const clear = await markPending(dir, "s1", { kind: "permission", title: "Bash  npm\n test" });
  const pending = await readPending(dir, "s1");
  assert.equal(pending?.kind, "permission");
  assert.equal(pending?.title, "Bash npm test");
  await clear();
  assert.equal(await readPending(dir, "s1"), null);
});

test("a cleared request does not erase a newer one", async () => {
  const dir = stateDir();
  const clearFirst = await markPending(dir, "s1", { kind: "permission", title: "first" });
  await markPending(dir, "s1", { kind: "question", title: "second" });
  await clearFirst();
  assert.equal((await readPending(dir, "s1"))?.kind, "question");
});

test("ignores a request left by a process that is gone", async () => {
  const dir = stateDir();
  mkdirSync(join(dir, "pending"));
  writeFileSync(
    join(dir, "pending", "s1.json"),
    JSON.stringify({ kind: "question", title: "q", since: "2026-10-09T12:00:00Z", pid: 2 ** 22 + 12345, token: "t" }),
  );
  assert.equal(await readPending(dir, "s1"), null);
});
