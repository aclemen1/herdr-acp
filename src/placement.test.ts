import assert from "node:assert/strict";
import { test } from "node:test";
import type { Herdr } from "./herdr.ts";
import { placePane, type SessionConfig } from "./session.ts";

function fakeHerdr(workspaces: { workspace_id: string; label: string }[]) {
  const calls: string[] = [];
  let n = 0;
  const herdr = {
    async listWorkspaces() {
      return workspaces;
    },
    async createWorkspace(opts: { label: string }) {
      n++;
      calls.push(`workspace create ${opts.label}`);
      workspaces.push({ workspace_id: `w${n}`, label: opts.label });
      return { workspace: { workspace_id: `w${n}`, label: opts.label }, tab: { tab_id: `w${n}:t1` }, root_pane: { pane_id: `w${n}:p1` } };
    },
    async createTab(opts: { workspaceId: string; label: string }) {
      calls.push(`tab create ${opts.workspaceId} ${opts.label}`);
      return { tab: { tab_id: `${opts.workspaceId}:t9` }, root_pane: { pane_id: `${opts.workspaceId}:p9` } };
    },
    async renameTab(tabId: string, label: string) {
      calls.push(`tab rename ${tabId} ${label}`);
    },
  };
  return { herdr: herdr as unknown as Herdr, calls };
}

function config(herdr: Herdr): SessionConfig {
  return { herdr, workspaceLabel: "offices-perso", paneEnv: {}, stateDir: "/tmp/none", driver: { kind: "claude" } } as unknown as SessionConfig;
}

test("a session's own workspace is created with its tab", async () => {
  const { herdr, calls } = fakeHerdr([{ workspace_id: "w0", label: "offices-perso" }]);
  const placement = await placePane(config(herdr), "abcdef1234", "/tmp", "P-0001 · Armoire", "P-0001 · Armoire");
  assert.deepEqual(calls, ["workspace create P-0001 · Armoire", "tab rename w1:t1 P-0001 · Armoire"]);
  assert.deepEqual(placement, { paneId: "w1:p1", tabId: "w1:t1" });
});

test("a session joins the workspace that already bears its label", async () => {
  const { herdr, calls } = fakeHerdr([{ workspace_id: "w7", label: "P-0001 · Armoire" }]);
  const placement = await placePane(config(herdr), "abcdef1234", "/tmp", "P-0001 · Armoire · tests", "P-0001 · Armoire");
  assert.deepEqual(calls, ["tab create w7 P-0001 · Armoire · tests"]);
  assert.deepEqual(placement, { paneId: "w7:p9", tabId: "w7:t9" });
});

test("without a workspace of its own, a session goes to --workspace", async () => {
  const { herdr, calls } = fakeHerdr([{ workspace_id: "w0", label: "offices-perso" }]);
  await placePane(config(herdr), "abcdef1234", "/tmp", "P-0001 · Armoire");
  assert.deepEqual(calls, ["tab create w0 P-0001 · Armoire"]);
});
