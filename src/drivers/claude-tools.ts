import type { ToolKind } from "@agentclientprotocol/sdk";

export function toolKind(name: string): ToolKind {
  switch (name) {
    case "Read":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "execute";
    case "Grep":
    case "Glob":
    case "ToolSearch":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    case "Task":
    case "Agent":
      return "think";
    default:
      return "other";
  }
}

export function toolTitle(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  switch (name) {
    case "Bash":
      return str("description") ?? str("command") ?? name;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `${name} ${str("file_path") ?? ""}`.trim();
    case "Grep":
    case "Glob":
      return `${name} ${str("pattern") ?? ""}`.trim();
    case "WebFetch":
      return `Fetch ${str("url") ?? ""}`.trim();
    case "WebSearch":
      return `Search ${str("query") ?? ""}`.trim();
    case "Task":
    case "Agent":
      return str("description") ?? name;
    case "AskUserQuestion": {
      const questions = Array.isArray(args.questions) ? (args.questions as Array<{ question?: unknown }>) : [];
      return typeof questions[0]?.question === "string" ? questions[0].question : name;
    }
    default:
      return name;
  }
}

export function toolLocations(input: unknown): { path: string }[] | undefined {
  const args = (input ?? {}) as Record<string, unknown>;
  const path = typeof args.file_path === "string" ? args.file_path : typeof args.notebook_path === "string" ? args.notebook_path : undefined;
  return path ? [{ path }] : undefined;
}
