import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliverToInbox, isQueuedPrompt, peerMessageBody } from "./claude-messaging.ts";

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
  assert.equal(await deliverToInbox("sid-1", "hello", registry("sid-1", socketPath)), true);
  assert.deepEqual((await received).map((line) => JSON.parse(line)), [
    { type: "auth", token: "secret" },
    { type: "user", message: { role: "user", content: "hello" } },
  ]);
});

test("fails without a registry entry or a listening socket", async () => {
  const dir = registry("sid-1", join(tmpdir(), "missing-herdr-acp.sock"));
  assert.equal(await deliverToInbox("other", "hello", dir), false);
  assert.equal(await deliverToInbox("sid-1", "hello", dir), false);
  assert.equal(await deliverToInbox("sid-1", "hello", join(tmpdir(), "no-such-dir-herdr-acp")), false);
});

test("recognizes the enqueue record of the delivered prompt", () => {
  assert.ok(isQueuedPrompt({ type: "queue-operation", operation: "enqueue", content: "hello\n" }, "hello"));
  assert.ok(!isQueuedPrompt({ type: "queue-operation", operation: "enqueue", content: "other" }, "hello"));
  assert.ok(!isQueuedPrompt({ type: "queue-operation", operation: "dequeue" }, "hello"));
});

test("strips Claude's peer frame", () => {
  const framed = "Another Claude session sent a message:\nline 1\nline 2\n\nThis came from another Claude session — not typed by your user.";
  assert.equal(peerMessageBody(framed), "line 1\nline 2");
  assert.equal(peerMessageBody("plain"), "plain");
});
