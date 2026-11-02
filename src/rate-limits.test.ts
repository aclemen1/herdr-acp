import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeWindows, rateLimitsPath, recordRateLimits } from "./rate-limits.ts";

const now = new Date("2026-11-02T03:00:00Z");
const nowS = now.getTime() / 1000;

test("the path follows the environment, off turns it off", () => {
  assert.equal(rateLimitsPath({ OFFICE_RATE_LIMITS_FILE: "/x/rl.json" }), "/x/rl.json");
  assert.equal(rateLimitsPath({ OFFICE_RATE_LIMITS_FILE: "off" }), null);
  assert.equal(rateLimitsPath({ XDG_STATE_HOME: "/s" }), "/s/office/rate-limits.json");
});

test("a window keeps its highest reading, a later window replaces it, a past one goes", () => {
  const old = { five_hour: { used_percentage: 80, resets_at: nowS + 3600 }, seven_day: { used_percentage: 91, resets_at: nowS - 1 } };
  const stale = mergeWindows(old, { five_hour: { used_percentage: 60, resets_at: nowS + 3601 } }, nowS);
  assert.deepEqual(stale, { five_hour: { used_percentage: 80, resets_at: nowS + 3601 } });
  const next = mergeWindows(old, { five_hour: { used_percentage: 3, resets_at: nowS + 5 * 3600 } }, nowS);
  assert.equal(next.five_hour?.used_percentage, 3);
  assert.equal(next.seven_day, undefined);
});

test("records the status line's rate limits atomically, and nothing without them", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-acp-rl-"));
  const path = join(dir, "office", "rate-limits.json");
  assert.equal(recordRateLimits({ model: {} }, path, now), false);
  assert.equal(existsSync(path), false);
  const input = { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: nowS + 600 }, seven_day: { used_percentage: 41.2, resets_at: nowS + 86400 } } };
  assert.equal(recordRateLimits(input, path, now), true);
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.updated_at, now.toISOString());
  assert.deepEqual(file.rate_limits, input.rate_limits);
  writeFileSync(path, "not json");
  assert.equal(recordRateLimits(input, path, now), true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).rate_limits.seven_day.used_percentage, 41.2);
});

test("the status line wrapper writes the file and still prints the original", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-acp-rl-"));
  const path = join(dir, "rl.json");
  const script = fileURLToPath(new URL("./statusline.ts", import.meta.url));
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const original = Buffer.from("cat >/dev/null; echo shown").toString("base64url");
  const out = spawnSync(process.execPath, [script, original], {
    input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 97, resets_at: resets } } }),
    env: { ...process.env, OFFICE_RATE_LIMITS_FILE: path, HERDR_ACP_SOCKET: join(dir, "none.sock") },
    encoding: "utf8",
  });
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), "shown");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).rate_limits.five_hour.used_percentage, 97);
});
