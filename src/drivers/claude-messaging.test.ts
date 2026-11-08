import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliverToInbox, isHeldPrompt, isQueuedPrompt, peerEnvelope, peerMessageBody, peerModeOf } from "./claude-messaging.ts";

function registry(sessionId: string, socketPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-reg-"));
  writeFileSync(join(dir, "123.json"), JSON.stringify({ pid: 123, sessionId, messagingSocketPath: socketPath, peerProtocol: 1 }));
  writeFileSync(join(dir, "123.abc.key"), JSON.stringify({ peerToken: "secret" }));
  return dir;
}

test("sends the auth line then the user message to the session's inbox", async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "cc-s-")), "s.sock");
  const received = new Promise<string[]>((resolve) => {
    const server = createServer((socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => {
        server.close();
        resolve(data.trim().split("\n"));
      });
    });
    server.listen(socketPath);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await deliverToInbox("sid-1", "hello", "bypass", registry("sid-1", socketPath)), true);
  assert.deepEqual((await received).map((line) => JSON.parse(line)), [
    { type: "auth", token: "secret" },
    {
      type: "user",
      message: { role: "user", content: '<cross-session-message from-name="herdr-acp" from-mode="bypass">\nhello\n</cross-session-message>' },
    },
  ]);
});

test("fails without a registry entry or a listening socket", async () => {
  const dir = registry("sid-1", join(tmpdir(), "missing-herdr-acp.sock"));
  assert.equal(await deliverToInbox("other", "hello", "bypass", dir), false);
  assert.equal(await deliverToInbox("sid-1", "hello", "bypass", dir), false);
  assert.equal(await deliverToInbox("sid-1", "hello", "bypass", join(tmpdir(), "no-such-dir-herdr-acp")), false);
});

test("recognizes the enqueue record of the delivered prompt", () => {
  assert.ok(isQueuedPrompt({ type: "queue-operation", operation: "enqueue", content: "hello\n" }, "hello"));
  assert.ok(!isQueuedPrompt({ type: "queue-operation", operation: "enqueue", content: "other" }, "hello"));
  assert.ok(!isQueuedPrompt({ type: "queue-operation", operation: "dequeue" }, "hello"));
});

test("recognizes the enqueue record without content a compacting session makes of the delivered prompt", () => {
  assert.ok(isQueuedPrompt({ type: "queue-operation", operation: "enqueue", sessionId: "s" }, "hello"));
});

test("recognizes the user record an idle session makes of the delivered prompt", () => {
  const framed = (body: string) =>
    `Another Claude session sent a message:\n${body}\n\nThis came from another Claude session — not typed by your user.`;
  const text = "[dossier · samedi 24 octobre 2026, 18:00 (+02:00)]\n\nRythme de CABINET : le soir.";
  assert.ok(isQueuedPrompt({ type: "user", message: { role: "user", content: framed(text) } }, text));
  assert.ok(!isQueuedPrompt({ type: "user", message: { role: "user", content: framed("other") } }, text));
  // The same words typed by the user are not the inbox's delivery.
  assert.ok(!isQueuedPrompt({ type: "user", message: { role: "user", content: text } }, text));
  assert.ok(!isQueuedPrompt({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }, text));
});

test("strips Claude's peer frame", () => {
  const framed = "Another Claude session sent a message:\nline 1\nline 2\n\nThis came from another Claude session — not typed by your user.";
  assert.equal(peerMessageBody(framed), "line 1\nline 2");
  assert.equal(peerMessageBody("plain"), "plain");
});

test("attests the class Claude Code gives the session's mode", () => {
  assert.equal(peerModeOf("bypassPermissions", false), "bypass");
  assert.equal(peerModeOf("plan", true), "bypass");
  assert.equal(peerModeOf("plan", false), "prompting");
  assert.equal(peerModeOf("auto", true), "prompting");
  assert.equal(peerModeOf("default", false), "prompting");
});

test("recognizes the records of an attested delivery", () => {
  const text = "line 1\nline 2";
  const sent = peerEnvelope(text, "prompting");
  assert.equal(peerMessageBody(sent), text);
  assert.ok(isQueuedPrompt({ type: "queue-operation", operation: "enqueue", content: sent }, text));
  const framed = `Another Claude session sent a message:\n${sent}\n\nThis came from another Claude session — not typed by your user.`;
  assert.ok(isQueuedPrompt({ type: "user", message: { role: "user", content: framed } }, text));
  assert.ok(isQueuedPrompt({ type: "user", message: { role: "user", content: sent } }, text));
  assert.ok(!isQueuedPrompt({ type: "user", message: { role: "user", content: peerEnvelope("other", "bypass") } }, text));
});

test("recognizes the record of a held delivery", () => {
  const text = "[dossier · dimanche 8 novembre 2026, 13:45 (+01:00)]\n\nDu dossier CABINET : essai.";
  const held = (preview: string, name = "herdr-acp") =>
    `Held peer message — from an unidentified session [verified pid 478203] (peer claims name: ${name}); preview: «${preview}» …[6 lines, 711 chars total — expand to review before approving] — not delivered to Claude (1 held). Your "crossSessionInbound" setting is "hold"; set it to "accept" to deliver held messages.`;
  assert.ok(isHeldPrompt({ type: "system", subtype: "informational", content: held("dossier · dimanche 8 novembre 2026, 13:45 +01:00") }, text));
  assert.ok(!isHeldPrompt({ type: "system", content: held("dossier · lundi 9 novembre 2026, 08:00 +01:00") }, text));
  assert.ok(!isHeldPrompt({ type: "system", content: held("dossier · dimanche 8 novembre 2026, 13:45 +01:00", "CABINET") }, text));
  assert.ok(!isHeldPrompt({ type: "user", message: { role: "user", content: text } }, text));
});
