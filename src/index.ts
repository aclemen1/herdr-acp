#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAgent } from "./agent.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import type { Driver } from "./drivers/types.ts";
import { Herdr } from "./herdr.ts";
import { defaultStateDir, hookCommand } from "./hook-bridge.ts";

const USAGE = `Usage: herdr-acp [options] [-- <agent args>...]
       herdr-acp install-hooks [--agent <kind>]
       herdr-acp uninstall-hooks [--agent <kind>]

ACP server over stdio. Each ACP session runs an interactive agent in its own herdr tab.
install-hooks adds the herdr-acp hooks to the agent's user settings, so that sessions started
outside herdr-acp can be driven over ACP too. The hooks do nothing while no herdr-acp is attached.

Options:
  --agent <kind>          Agent kind (default: claude)
  --workspace <label>     herdr workspace that hosts session tabs (default: acp)
  --herdr-session <name>  Named herdr session (default: the default session)
  --machine <label>       Saved herdr SSH machine
  --forward-env <list>    Comma-separated variable names forwarded to panes; NAME* matches a prefix
  --start-timeout <ms>    Agent startup timeout (default: 60000)
  --trust-folders         Accept the agent's folder trust dialog when the ACP client cannot be asked
  -h, --help              Show this help

Environment fallbacks: HERDR_ACP_AGENT, HERDR_ACP_WORKSPACE, HERDR_ACP_HERDR_SESSION,
HERDR_ACP_MACHINE, HERDR_ACP_FORWARD_ENV, HERDR_ACP_TRUST_FOLDERS=1.`;

const DRIVERS: Record<string, () => Driver> = {
  claude: () => new ClaudeDriver(),
};

const command = process.argv[2] === "install-hooks" || process.argv[2] === "uninstall-hooks" ? process.argv[2] : null;

const { values, positionals } = parseArgs({
  args: process.argv.slice(command ? 3 : 2),
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    workspace: { type: "string" },
    "herdr-session": { type: "string" },
    machine: { type: "string" },
    "forward-env": { type: "string" },
    "start-timeout": { type: "string" },
    "trust-folders": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(0);
}

const env = process.env;
const kind = values.agent ?? env.HERDR_ACP_AGENT ?? "claude";
const makeDriver = DRIVERS[kind];
if (!makeDriver) {
  process.stderr.write(`herdr-acp: unsupported agent kind "${kind}" (supported: ${Object.keys(DRIVERS).join(", ")})\n`);
  process.exit(2);
}

if (command) {
  const driver = makeDriver();
  const path =
    command === "install-hooks"
      ? await driver.installGlobalHooks(hookCommand({ global: true }))
      : await driver.uninstallGlobalHooks();
  process.stderr.write(`herdr-acp: ${command === "install-hooks" ? "installed hooks in" : "removed hooks from"} ${path}\n`);
  process.exit(0);
}

const { app, disposeAll } = createAgent(
  {
    herdr: new Herdr({
      session: values["herdr-session"] ?? env.HERDR_ACP_HERDR_SESSION,
      machine: values.machine ?? env.HERDR_ACP_MACHINE,
    }),
    driver: makeDriver(),
    workspaceLabel: values.workspace ?? env.HERDR_ACP_WORKSPACE ?? "acp",
    paneEnv: selectEnv(values["forward-env"] ?? env.HERDR_ACP_FORWARD_ENV ?? ""),
    extraArgs: positionals,
    stateDir: defaultStateDir(env),
    startTimeoutMs: Number(values["start-timeout"] ?? 60_000),
    pollMs: 300,
    idleSettleMs: 2_500,
    trustFolders: values["trust-folders"] ?? env.HERDR_ACP_TRUST_FOLDERS === "1",
    client: { capabilities: null },
  },
  readVersion(),
);

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);
const shutdown = async () => {
  await disposeAll();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void shutdown());
await connection.closed;
await shutdown();

function selectEnv(spec: string): Record<string, string> {
  const patterns = spec.split(",").map((item) => item.trim()).filter(Boolean);
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (patterns.some((pattern) => (pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern))) {
      selected[key] = value;
    }
  }
  return selected;
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}
