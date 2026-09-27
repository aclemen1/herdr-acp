import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function promptToText(blocks: ContentBlock[], options: { attachmentDir: string }): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource_link":
        parts.push(mention(block.uri));
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource) {
          parts.push(`<context uri="${resource.uri}">\n${resource.text}\n</context>`);
        } else {
          parts.push(mention(resource.uri));
        }
        break;
      }
      case "image": {
        if (block.uri?.startsWith("file://")) {
          parts.push(mention(block.uri));
          break;
        }
        const extension = IMAGE_EXTENSIONS[block.mimeType];
        if (!extension) throw new Error(`Unsupported image type: ${block.mimeType}`);
        await mkdir(options.attachmentDir, { recursive: true, mode: 0o700 });
        const path = join(options.attachmentDir, `${randomUUID()}.${extension}`);
        await writeFile(path, Buffer.from(block.data, "base64"), { mode: 0o600 });
        parts.push(`@${path}`);
        break;
      }
      default:
        throw new Error(`Unsupported prompt content type: ${block.type}`);
    }
  }
  const text = parts.join("\n\n").trim();
  return /@\S+$/.test(text) ? `${text} ` : text;
}

function mention(uri: string): string {
  if (uri.startsWith("file://")) return `@${fileURLToPath(uri)}`;
  return uri;
}
