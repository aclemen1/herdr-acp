import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeDriver, encodeProjectDir } from "./claude.ts";
import { claudeConfigOptions } from "./claude-config.ts";
import { claudeModes } from "./claude-modes.ts";

test("exposes mode, model and effort as config options", () => {
  const options = claudeConfigOptions({ mode: "plan", model: "default", effort: "high" }, claudeModes([]), "Opus 5.5");
  assert.deepEqual(
    options.map((option) => [option.id, option.category, option.type === "select" ? option.currentValue : null]),
    [
      ["mode", "mode", "plan"],
      ["model", "model", "default"],
      ["effort", "thought_level", "high"],
    ],
  );
  const model = options[1]!;
  assert.ok(model.type === "select" && JSON.stringify(model.options).includes("Default (Opus 5.5)"));
});

test("adds an unknown current model as its own option", () => {
  const [, model] = claudeConfigOptions({ mode: "default", model: "claude-custom", effort: null }, claudeModes([]), "Custom");
  assert.ok(model?.type === "select" && JSON.stringify(model.options).includes('"value":"claude-custom"'));
});

async function withConfigDir<T>(settings: unknown, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-acp-cfg-"));
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

test("builds launch arguments with status line wrapper, settings and restrictions", async () => {
  await withConfigDir({ statusLine: { type: "command", command: "my-status", padding: 1 } }, async () => {
    const args = await new ClaudeDriver().launchArgs({
      sessionId: "s1",
      resume: true,
      cwd: "/tmp",
      mcpServers: [],
      stateDir: tmpdir(),
      extraArgs: ["--model", "sonnet", "--verbose"],
      hookCommand: "hook",
      statusLineCommand: "wrap",
      clientCanElicit: false,
      trustApproved: false,
      interaction: "client",
      mode: "plan",
      effort: "max",
    });
    const settings = JSON.parse(await readFile(args[args.indexOf("--settings") + 1]!, "utf8")) as {
      statusLine: unknown;
      hooks: object;
    };
    assert.deepEqual(settings.statusLine, {
      type: "command",
      command: `wrap ${Buffer.from("my-status").toString("base64url")}`,
      padding: 1,
    });
    assert.ok("UserPromptSubmit" in settings.hooks);
    const tail = args.slice(args.indexOf("--settings") + 2);
    assert.deepEqual(tail, [
      "--model",
      "sonnet",
      "--verbose",
      "--permission-mode",
      "plan",
      "--effort",
      "max",
      "--disallowedTools",
      "AskUserQuestion",
    ]);
    assert.deepEqual(args.slice(0, 2), ["--resume", "s1"]);
  });
});

test("lists stored transcripts with their latest title", async () => {
  await withConfigDir({}, async (configDir) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "herdr-acp-proj-")));
    const dir = join(configDir, "projects", encodeProjectDir(cwd));
    await mkdir(dir, { recursive: true });
    const lines = [
      { type: "ai-title", aiTitle: "Old" },
      { type: "user", message: { content: "hi" } },
      { type: "ai-title", aiTitle: "New" },
    ];
    await writeFile(join(dir, "abc.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
    const listed = await new ClaudeDriver().listTranscripts(cwd);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.sessionId, "abc");
    assert.equal(listed[0]!.title, "New");
  });
});

test("always exposes effort, with a default value when unknown", () => {
  const effort = claudeConfigOptions({ mode: "default", model: "default", effort: null }, claudeModes([]), null).find(
    (option) => option.id === "effort",
  );
  assert.ok(effort?.type === "select" && effort.currentValue === "default");
});

test("forks a stored session under a new id", async () => {
  await withConfigDir({}, async () => {
    const args = await new ClaudeDriver().launchArgs({
      sessionId: "new-id",
      resume: false,
      forkFrom: "old-id",
      cwd: "/tmp",
      mcpServers: [],
      stateDir: tmpdir(),
      extraArgs: [],
      hookCommand: "hook",
      statusLineCommand: "wrap",
      clientCanElicit: true,
      trustApproved: false,
      interaction: "client",
    });
    assert.deepEqual(args.slice(0, 5), ["--resume", "old-id", "--fork-session", "--session-id", "new-id"]);
  });
});

test("never disables AskUserQuestion in native interaction", async () => {
  await withConfigDir({}, async () => {
    const args = await new ClaudeDriver().launchArgs({
      sessionId: "s",
      resume: false,
      cwd: "/tmp",
      mcpServers: [],
      stateDir: tmpdir(),
      extraArgs: [],
      hookCommand: "hook",
      statusLineCommand: "wrap",
      clientCanElicit: false,
      trustApproved: false,
      interaction: "native",
    });
    assert.equal(args.includes("--disallowedTools"), false);
  });
});
