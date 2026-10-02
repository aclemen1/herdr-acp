import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInfo, PaneInfo, TabInfo } from "./herdr.ts";
import { planReattach, releasePane, stopAgent } from "./pane-release.ts";

const claude = { kind: "claude", exitCommand: "/exit" };

type Layout = { panes: Record<string, PaneInfo>; tabs: Record<string, number> };

function fakeHerdr(opts: { exitsAfter: number; failClose?: boolean; layout?: Layout }) {
  const calls: string[] = [];
  let polls = 0;
  const layout: Layout = opts.layout ?? {
    panes: { p1: { pane_id: "p1", tab_id: "t1", workspace_id: "w1" } },
    tabs: { t1: 1 },
  };
  return {
    calls,
    async prompt(target: string, text: string) {
      calls.push(`prompt ${target} ${text}`);
    },
    async getAgent(target: string): Promise<AgentInfo> {
      calls.push(`get ${target}`);
      if (++polls > opts.exitsAfter) throw new Error("no agent in pane");
      return { agent: "claude", pane_id: target } as AgentInfo;
    },
    async getPane(paneId: string): Promise<PaneInfo | null> {
      return layout.panes[paneId] ?? null;
    },
    async getTab(tabId: string): Promise<TabInfo | null> {
      const count = layout.tabs[tabId];
      return count === undefined ? null : { tab_id: tabId, workspace_id: "w", label: "", pane_count: count };
    },
    async closeTab(tabId: string) {
      calls.push(`close tab ${tabId}`);
      if (opts.failClose) throw new Error("tab gone");
    },
    async closePane(paneId: string) {
      calls.push(`close pane ${paneId}`);
    },
  };
}

const moved: Layout = {
  panes: {
    "w1:p1": { pane_id: "w2:p7", tab_id: "w2:t1", workspace_id: "w2" },
    "w2:p7": { pane_id: "w2:p7", tab_id: "w2:t1", workspace_id: "w2" },
  },
  tabs: { "w2:t1": 2 },
};

test("exits the agent before closing the tab it owns", async () => {
  const herdr = fakeHerdr({ exitsAfter: 2 });
  await releasePane(herdr, claude, { paneId: "p1", ownedTabId: "t1" }, { pollMs: 1, timeoutMs: 1_000 });
  assert.deepEqual(herdr.calls, ["prompt p1 /exit", "get p1", "get p1", "get p1", "close tab t1"]);
});

test("closes the owned tab even when the agent does not exit in time", async () => {
  const herdr = fakeHerdr({ exitsAfter: Number.POSITIVE_INFINITY });
  await releasePane(herdr, claude, { paneId: "p1", ownedTabId: "t1" }, { pollMs: 1, timeoutMs: 5 });
  assert.equal(herdr.calls.at(-1), "close tab t1");
});

test("a tab that is already gone is not an error", async () => {
  const herdr = fakeHerdr({ exitsAfter: 0, failClose: true });
  await releasePane(herdr, claude, { paneId: "p1", ownedTabId: "t1" }, { pollMs: 1, timeoutMs: 1_000 });
  assert.equal(herdr.calls.at(-1), "close tab t1");
});

test("closes only the pane when it was moved into another tab, using its new id", async () => {
  const herdr = fakeHerdr({ exitsAfter: 0, layout: moved });
  await releasePane(herdr, claude, { paneId: "w1:p1", ownedTabId: "w1:t1" }, { pollMs: 1, timeoutMs: 1_000 });
  assert.deepEqual(herdr.calls, ["prompt w2:p7 /exit", "get w2:p7", "close pane w2:p7"]);
});

test("closes only the pane when its own tab is shared with another pane", async () => {
  const herdr = fakeHerdr({
    exitsAfter: 0,
    layout: { panes: { p1: { pane_id: "p1", tab_id: "t1", workspace_id: "w1" } }, tabs: { t1: 2 } },
  });
  await releasePane(herdr, claude, { paneId: "p1", ownedTabId: "t1" }, { pollMs: 1, timeoutMs: 1_000 });
  assert.equal(herdr.calls.at(-1), "close pane p1");
});

test("never closes a tab it does not own", async () => {
  const herdr = fakeHerdr({ exitsAfter: 0 });
  await releasePane(herdr, claude, { paneId: "p1", ownedTabId: null }, { pollMs: 1, timeoutMs: 1_000 });
  assert.equal(herdr.calls.at(-1), "close pane p1");
});

test("reattach owns the recorded tab only while the pane is alone in it", async () => {
  const alone = fakeHerdr({ exitsAfter: 0 });
  assert.deepEqual(await planReattach(alone, { paneId: "p1", tabId: "t1" }), {
    pane: { pane_id: "p1", tab_id: "t1", workspace_id: "w1" },
    owned: true,
    renamedId: false,
  });
  const shared = fakeHerdr({
    exitsAfter: 0,
    layout: { panes: { p1: { pane_id: "p1", tab_id: "t1", workspace_id: "w1" } }, tabs: { t1: 2 } },
  });
  assert.equal((await planReattach(shared, { paneId: "p1", tabId: "t1" }))?.owned, false);
});

test("reattach follows a pane moved to another workspace and observes its new tab", async () => {
  const herdr = fakeHerdr({ exitsAfter: 0, layout: moved });
  assert.deepEqual(await planReattach(herdr, { paneId: "w1:p1", tabId: "w1:t1" }), {
    pane: { pane_id: "w2:p7", tab_id: "w2:t1", workspace_id: "w2" },
    owned: false,
    renamedId: true,
  });
  assert.equal(await planReattach(herdr, { paneId: "gone", tabId: "w1:t1" }), null);
});

test("stopAgent reports a timeout", async () => {
  const herdr = fakeHerdr({ exitsAfter: Number.POSITIVE_INFINITY });
  assert.equal(await stopAgent(herdr, claude, "p1", { pollMs: 1, timeoutMs: 5 }), false);
});
