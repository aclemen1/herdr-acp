import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireOwnership, checkOwnership, readOwner, releaseOwnership, SESSION_OWNED_ERROR } from "./ownership.ts";

async function stateWithOwner(pid: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-acp-owner-"));
  await mkdir(join(dir, "owners"), { recursive: true });
  await writeFile(join(dir, "owners", "s1.json"), JSON.stringify({ pid, since: "2026-09-30T00:00:00.000Z" }));
  return dir;
}

test("refuses a session held by another live process unless taking over", async () => {
  const dir = await stateWithOwner(process.ppid);
  await assert.rejects(acquireOwnership(dir, "s1", false), (error: { code: number; data: Record<string, unknown> }) => {
    assert.equal(error.code, SESSION_OWNED_ERROR);
    assert.deepEqual(error.data, {
      sessionId: "s1",
      ownerPid: process.ppid,
      ownerSince: "2026-09-30T00:00:00.000Z",
      takeover: "_meta.herdr.takeover",
    });
    return true;
  });
  await acquireOwnership(dir, "s1", true);
  assert.equal((await readOwner(dir, "s1"))?.pid, process.pid);
});

test("ignores a lock left by a dead process and releases only its own lock", async () => {
  const dir = await stateWithOwner(2 ** 22 + 12345);
  const token = await acquireOwnership(dir, "s1", false);
  await checkOwnership(dir, "s1", token);
  await releaseOwnership(dir, "s1", token);
  assert.equal(await readOwner(dir, "s1"), null);
});

test("an owner that was taken over stays dispossessed, even after the new owner leaves", async () => {
  const dir = await stateWithOwner(2 ** 22 + 12345);
  const first = await acquireOwnership(dir, "s1", false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await acquireOwnership(dir, "s1", true);
  await assert.rejects(checkOwnership(dir, "s1", first), /taken over/);
  await releaseOwnership(dir, "s1", first);
  assert.deepEqual(await readOwner(dir, "s1"), second);
  await releaseOwnership(dir, "s1", second);
  await assert.rejects(checkOwnership(dir, "s1", first), /taken over/);
});
