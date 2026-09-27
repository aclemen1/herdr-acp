import { readFile } from "node:fs/promises";
import type { SessionConfigOption, SessionMode } from "@agentclientprotocol/sdk";
import { claudeUserSettingsPath } from "./claude-settings.ts";
import type { SessionSettings } from "./types.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const MODEL_ALIASES: { value: string; name: string }[] = [
  { value: "default", name: "Default" },
  { value: "fable", name: "Fable" },
  { value: "opus", name: "Opus" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku" },
];

export function argValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function withoutArg(args: string[], flag: string): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) i++;
    else if (!arg.startsWith(`${flag}=`)) rest.push(arg);
  }
  return rest;
}

export async function readUserSettings(path = claudeUserSettingsPath()): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function claudeInitialModel(extraArgs: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const settings = await readUserSettings();
  return argValue(extraArgs, "--model") ?? env.ANTHROPIC_MODEL ?? (typeof settings.model === "string" ? settings.model : "default");
}

export function claudeConfigOptions(
  settings: SessionSettings,
  modes: SessionMode[],
  modelLabel: string | null,
): SessionConfigOption[] {
  const models = [...MODEL_ALIASES];
  if (!models.some((model) => model.value === settings.model)) models.push({ value: settings.model, name: modelLabel ?? settings.model });
  const labelled = models.map((model) =>
    model.value === settings.model && modelLabel && model.value !== modelLabel ? { ...model, name: `${model.name} (${modelLabel})` } : model,
  );
  const options: SessionConfigOption[] = [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: settings.mode,
      options: modes.map((mode) => ({ value: mode.id, name: mode.name })),
    },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: settings.model, options: labelled },
  ];
  options.push({
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: settings.effort ?? "default",
    options: [
      { value: "default", name: "Default" },
      ...EFFORT_LEVELS.map((level) => ({ value: level, name: level[0]!.toUpperCase() + level.slice(1) })),
    ],
  });
  return options;
}
