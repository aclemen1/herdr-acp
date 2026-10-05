import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Herdr, HerdrError } from "./herdr.ts";

// Answers server_not_running until a `server` invocation has created the marker file.
function fakeBin(): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "herdr-acp-herdr-"));
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
case " $* " in
  *" server "*) touch "${dir}/up"; exit 0 ;;
esac
if [ -f "${dir}/up" ]; then echo '{"result":{"workspaces":[]}}'; exit 0; fi
echo '{"error":{"code":"server_not_running","message":"no server"}}' >&2
exit 1
`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

const calls = (dir: string) => readFileSync(join(dir, "calls"), "utf8").trim().split("\n");

test("starts the server of a named session that is not running, then retries", async () => {
  const { bin, dir } = fakeBin();
  const herdr = new Herdr({ bin, session: "routine", serverGraceMs: 0 });
  assert.deepEqual(await herdr.listWorkspaces(), []);
  assert.ok(existsSync(join(dir, "up")));
  assert.ok(calls(dir).includes("--session routine server"));
});

test("starts the server once for concurrent calls", async () => {
  const { bin, dir } = fakeBin();
  const herdr = new Herdr({ bin, session: "routine", serverGraceMs: 0 });
  await Promise.all([herdr.listWorkspaces(), herdr.listWorkspaces()]);
  assert.equal(calls(dir).filter((line) => line.endsWith(" server")).length, 1);
});

test("does not start a server that comes back during the grace period", async () => {
  const { bin, dir } = fakeBin();
  setTimeout(() => writeFileSync(join(dir, "up"), ""), 300);
  assert.deepEqual(await new Herdr({ bin, session: "routine", serverGraceMs: 2_000 }).listWorkspaces(), []);
  assert.ok(!calls(dir).some((line) => line.endsWith(" server")));
});

test("does not start the default server", async () => {
  const { bin, dir } = fakeBin();
  await assert.rejects(new Herdr({ bin }).listWorkspaces(), (error) => error instanceof HerdrError && error.code === "server_not_running");
  assert.ok(!calls(dir).some((line) => line.endsWith("server")));
});

test("does not start a server on a remote machine", async () => {
  const { bin, dir } = fakeBin();
  await assert.rejects(new Herdr({ bin, session: "routine", machine: "box" }).listWorkspaces(), HerdrError);
  assert.ok(!calls(dir).some((line) => line.endsWith("server")));
});
