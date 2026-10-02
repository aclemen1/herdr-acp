import { setTimeout as sleep } from "node:timers/promises";
import type { AgentInfo, PaneInfo, TabInfo } from "./herdr.ts";

export type PaneHost = {
  prompt(target: string, text: string): Promise<unknown>;
  getAgent(target: string): Promise<AgentInfo>;
  getPane(paneId: string): Promise<PaneInfo | null>;
  getTab(tabId: string): Promise<TabInfo | null>;
  closeTab(tabId: string): Promise<void>;
  closePane(paneId: string): Promise<void>;
};

export type ExitSpec = { kind: string; exitCommand: string };

// Asks the agent to exit and waits until herdr no longer reports it in the pane.
export async function stopAgent(
  herdr: Pick<PaneHost, "prompt" | "getAgent">,
  driver: ExitSpec,
  paneId: string,
  opts: { pollMs: number; timeoutMs: number },
): Promise<boolean> {
  await herdr.prompt(paneId, driver.exitCommand);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const agent = await herdr.getAgent(paneId).catch(() => null);
    if (!agent || agent.agent !== driver.kind) return true;
    if (Date.now() > deadline) return false;
    await sleep(opts.pollMs);
  }
}

// A tab is owned when the pane still sits alone in the tab herdr-acp created for it.
export async function ownsTab(herdr: Pick<PaneHost, "getTab">, pane: PaneInfo, createdTabId: string | null): Promise<boolean> {
  if (!createdTabId || pane.tab_id !== createdTabId) return false;
  return (await herdr.getTab(pane.tab_id))?.pane_count === 1;
}

// Reattaching to a recorded pane: follow its current id and decide whether its tab is still owned.
export async function planReattach(
  herdr: Pick<PaneHost, "getPane" | "getTab">,
  record: { paneId: string; tabId: string },
): Promise<{ pane: PaneInfo; owned: boolean; renamedId: boolean } | null> {
  const pane = await herdr.getPane(record.paneId);
  if (!pane) return null;
  return { pane, owned: await ownsTab(herdr, pane, record.tabId), renamedId: pane.pane_id !== record.paneId };
}

// Exits the agent first so its transcript is complete for the next --resume, then closes the
// owned tab when the pane is still alone in it, or only the pane when it was moved elsewhere.
export async function releasePane(
  herdr: PaneHost,
  driver: ExitSpec,
  placement: { paneId: string; ownedTabId: string | null },
  opts: { pollMs: number; timeoutMs: number },
): Promise<void> {
  const before = await herdr.getPane(placement.paneId).catch(() => null);
  const paneId = before?.pane_id ?? placement.paneId;
  await stopAgent(herdr, driver, paneId, opts).catch(() => false);
  const pane = await herdr.getPane(paneId).catch(() => null);
  if (!pane) return;
  if (pane.tab_id === placement.ownedTabId && (await ownsTab(herdr, pane, placement.ownedTabId))) {
    await herdr.closeTab(pane.tab_id).catch(() => undefined);
  } else {
    await herdr.closePane(pane.pane_id).catch(() => undefined);
  }
}
