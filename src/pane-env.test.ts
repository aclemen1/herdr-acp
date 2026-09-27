import assert from "node:assert/strict";
import { test } from "node:test";
import { paneEnv } from "./pane-env.ts";

const protectedEnv = /^(ANTHROPIC_API_KEY|CLAUDE_CODE_\w*)$/;
const env = {
  PAPERCLIP_API_KEY: "p",
  ANTHROPIC_MODEL: "opus",
  ANTHROPIC_API_KEY: "secret",
  CLAUDE_CODE_CHILD_SESSION: "1",
  PATH: "/usr/bin",
  TERM: "xterm",
  HERDR_PANE_ID: "w1:p1",
  CUSTOM_TOKEN: "t",
};

test("forwards the client environment except terminal and protected variables", () => {
  assert.deepEqual(paneEnv(env, { protectedEnv, include: [], exclude: [] }), {
    PAPERCLIP_API_KEY: "p",
    ANTHROPIC_MODEL: "opus",
    CUSTOM_TOKEN: "t",
  });
});

test("forces exact names and applies extra exclusions", () => {
  assert.deepEqual(paneEnv(env, { protectedEnv, include: ["ANTHROPIC_API_KEY"], exclude: ["CUSTOM_*"] }), {
    PAPERCLIP_API_KEY: "p",
    ANTHROPIC_MODEL: "opus",
    ANTHROPIC_API_KEY: "secret",
  });
});
