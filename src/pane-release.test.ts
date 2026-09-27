import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInfo } from "./herdr.ts";
import { releasePane, stopAgent } from "./pane-release.ts";

const claude = { kind: "claude", exitCommand: "/exit" };

function fakeHerdr(opts: { exitsAfter: number; failClose?: boolean }) {
  const calls: string[] = [];
  let polls = 0;
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
    async closeTab(tabId: string) {
      calls.push(`close ${tabId}`);
      if (opts.failClose) throw new Error("tab gone");
    },
  };
}

test("exits the agent before closing its tab", async () => {
  const herdr = fakeHerdr({ exitsAfter: 2 });
  await releasePane(herdr, claude, { paneId: "p1", tabId: "t1" }, { pollMs: 1, timeoutMs: 1_000 });
  assert.deepEqual(herdr.calls, ["prompt p1 /exit", "get p1", "get p1", "get p1", "close t1"]);
});

test("closes the tab even when the agent does not exit in time", async () => {
  const herdr = fakeHerdr({ exitsAfter: Number.POSITIVE_INFINITY });
  await releasePane(herdr, claude, { paneId: "p1", tabId: "t1" }, { pollMs: 1, timeoutMs: 5 });
  assert.equal(herdr.calls.at(-1), "close t1");
});

test("a tab that is already gone is not an error", async () => {
  const herdr = fakeHerdr({ exitsAfter: 0, failClose: true });
  await releasePane(herdr, claude, { paneId: "p1", tabId: "t1" }, { pollMs: 1, timeoutMs: 1_000 });
  assert.equal(herdr.calls.at(-1), "close t1");
});

test("stopAgent reports a timeout", async () => {
  const herdr = fakeHerdr({ exitsAfter: Number.POSITIVE_INFINITY });
  assert.equal(await stopAgent(herdr, claude, "p1", { pollMs: 1, timeoutMs: 5 }), false);
});
