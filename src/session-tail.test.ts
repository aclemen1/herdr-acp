import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeDriver } from "./drivers/claude.ts";
import type { AgentInfo, Herdr } from "./herdr.ts";
import { type SessionConfig, tailSession } from "./session.ts";

const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const assistant = (id: string, text: string) =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });

function setup(agents: AgentInfo[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-acp-tail-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, `${user("Bonjour")}\n${assistant("m1", "Salut")}\n`);
  const driver = new ClaudeDriver();
  driver.transcriptPath = async () => path;
  const config = {
    driver,
    stateDir: dir,
    herdr: { listAgents: async () => agents } as unknown as Herdr,
  } as SessionConfig;
  return { config, path };
}

const texts = (updates: { sessionUpdate: string; content?: unknown }[]) =>
  updates.map((update) => `${update.sessionUpdate}:${(update.content as { text?: string } | undefined)?.text ?? ""}`);

test("returns the last updates and a cursor for the rest", async () => {
  const { config, path } = setup();
  const first = await tailSession(config, { sessionId: "s", limit: 20 });
  assert.deepEqual(texts(first.updates), ["user_message_chunk:Bonjour", "agent_message_chunk:Salut"]);
  assert.equal(first.status, undefined);

  appendFileSync(path, `${assistant("m2", "Encore")}\n{"type":"assistant","message":{"id":"m3"`);
  const next = await tailSession(config, { sessionId: "s", after: first.cursor, limit: 20 });
  assert.deepEqual(texts(next.updates), ["agent_message_chunk:Encore"]);

  const idle = await tailSession(config, { sessionId: "s", after: next.cursor, limit: 20 });
  assert.deepEqual(idle.updates, []);
  assert.equal(idle.cursor, next.cursor);
});

test("stamps each update with the time of its transcript line", async () => {
  const { config, path } = setup();
  const at = "2026-10-05T13:47:08.698Z";
  appendFileSync(path, `${JSON.stringify({ ...JSON.parse(assistant("m2", "Daté")), timestamp: at })}\n`);
  const { updates } = await tailSession(config, { sessionId: "s", limit: 20 });
  assert.equal(updates.at(-1)?._meta?.timestamp, at);
  assert.equal(updates[0]?._meta, undefined);
});

test("keeps only the last updates within the limit", async () => {
  const { config } = setup();
  assert.deepEqual(texts((await tailSession(config, { sessionId: "s", limit: 1 })).updates), ["agent_message_chunk:Salut"]);
});

test("restarts from the end when the transcript shrank", async () => {
  const { config } = setup();
  const result = await tailSession(config, { sessionId: "s", after: "999999", limit: 20 });
  assert.equal(result.reset, true);
  assert.equal(result.updates.length, 2);
});

test("returns nothing for a session without a transcript", async () => {
  const { config } = setup();
  config.driver.transcriptPath = async () => join(tmpdir(), "no-such-herdr-acp.jsonl");
  assert.deepEqual(await tailSession(config, { sessionId: "s", limit: 20 }), { updates: [], cursor: "0" });
});

test("reports the herdr status of the live pane", async () => {
  const agent = { agent: "claude", agent_status: "blocked", agent_session: { agent: "claude", kind: "id", source: "x", value: "s" }, pane_id: "p", tab_id: "t", workspace_id: "w" } as AgentInfo;
  const { config } = setup([agent]);
  assert.equal((await tailSession(config, { sessionId: "s", limit: 20 })).status, "blocked");
});
