import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promptToText } from "./prompt.ts";

test("joins text, file links and embedded resources", async () => {
  const text = await promptToText(
    [
      { type: "text", text: "Review this" },
      { type: "resource_link", uri: "file:///repo/src/a.ts", name: "a.ts" },
      { type: "resource", resource: { uri: "file:///repo/notes.md", text: "note" } },
    ],
    { attachmentDir: tmpdir() },
  );
  assert.equal(text, 'Review this\n\n@/repo/src/a.ts\n\n<context uri="file:///repo/notes.md">\nnote\n</context>');
});

test("stores inline images as files and mentions them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-acp-img-"));
  const text = await promptToText(
    [
      { type: "text", text: "Look" },
      { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
    ],
    { attachmentDir: dir },
  );
  assert.ok(text.endsWith(" "), "a trailing mention must end with a space so Enter submits instead of completing");
  const path = text.split("\n\n")[1]!.trim().slice(1);
  assert.ok(path.startsWith(dir) && path.endsWith(".png"));
  assert.equal(await readFile(path, "utf8"), "png-bytes");
});

test("rejects audio", async () => {
  await assert.rejects(promptToText([{ type: "audio", data: "", mimeType: "audio/wav" }], { attachmentDir: tmpdir() }), /Unsupported/);
});
