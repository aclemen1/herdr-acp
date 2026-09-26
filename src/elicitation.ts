import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";

export function elicitationContent(response: CreateElicitationResponse): Record<string, unknown> {
  return (response as { content?: Record<string, unknown> | null }).content ?? {};
}
