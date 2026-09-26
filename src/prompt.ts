import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

export function promptToText(blocks: ContentBlock[]): string {
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
      default:
        throw new Error(`Unsupported prompt content type: ${block.type}`);
    }
  }
  return parts.join("\n\n").trim();
}

function mention(uri: string): string {
  if (uri.startsWith("file://")) return `@${fileURLToPath(uri)}`;
  return uri;
}
