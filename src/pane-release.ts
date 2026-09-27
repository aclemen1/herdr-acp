import { setTimeout as sleep } from "node:timers/promises";
import type { AgentInfo } from "./herdr.ts";

export type PaneHost = {
  prompt(target: string, text: string): Promise<unknown>;
  getAgent(target: string): Promise<AgentInfo>;
  closeTab(tabId: string): Promise<void>;
};

export type ExitSpec = { kind: string; exitCommand: string };

// Asks the agent to exit and waits until herdr no longer reports it in the pane.
export async function stopAgent(
  herdr: PaneHost,
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

// Exits the agent first so its transcript is complete for the next --resume, then closes the tab.
export async function releasePane(
  herdr: PaneHost,
  driver: ExitSpec,
  placement: { paneId: string; tabId: string },
  opts: { pollMs: number; timeoutMs: number },
): Promise<void> {
  await stopAgent(herdr, driver, placement.paneId, opts).catch(() => false);
  await herdr.closeTab(placement.tabId).catch(() => undefined);
}
