import assert from "node:assert/strict";
import { test } from "node:test";
import { promptToText } from "./prompt.ts";

test("joins text, file links and embedded resources", () => {
  const text = promptToText([
    { type: "text", text: "Review this" },
    { type: "resource_link", uri: "file:///repo/src/a.ts", name: "a.ts" },
    { type: "resource", resource: { uri: "file:///repo/notes.md", text: "note" } },
  ]);
  assert.equal(text, 'Review this\n\n@/repo/src/a.ts\n\n<context uri="file:///repo/notes.md">\nnote\n</context>');
});

test("rejects images", () => {
  assert.throws(() => promptToText([{ type: "image", data: "", mimeType: "image/png" }]), /Unsupported/);
});
