# herdr-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server that drives **interactive** coding agents running in [herdr](https://herdr.dev) panes.

Each ACP session is a real agent TUI (Claude Code or Pi) in its own herdr tab. You can watch it, attach to it and take over at any time, while an ACP client (Zed, Paperclip, your own tool) sends prompts and receives structured updates. Because the agent runs interactively, it uses the same account and plan as when you run it by hand.

```
ACP client ──stdio──▶ herdr-acp ──herdr CLI──▶ herdr pane: claude / pi (TUI)
     ▲                    │  ▲                          │
     └── session/update ──┘  └── unix socket ◀── hooks / extension, transcript
```

## Requirements

- Node.js 22.18 or later
- herdr 0.9 or later, with its server running (`herdr status`)
- The agent CLI: `claude` (Claude Code) or `pi`

## Install

```sh
npm install -g herdr-acp        # or: npm install && npm run build, then use dist/index.js
```

## Use it from an ACP client

herdr-acp speaks ACP over stdio. Point your client at the `herdr-acp` command.

Zed (`settings.json`):

```json
{
  "agent_servers": {
    "Claude Code (herdr)": { "type": "custom", "command": "herdr-acp", "args": [] },
    "Pi (herdr)": { "type": "custom", "command": "herdr-acp", "args": ["--agent", "pi"] }
  }
}
```

Paperclip: create a `claude_local` agent with `"engine": "acp"` and `"agentCommand"` set to a small wrapper script:

```sh
#!/bin/sh
exec herdr-acp --trust-folders "$@"
```

`--trust-folders` is needed there because Paperclip runs agents in fresh worktrees and cannot answer the folder trust question.

Paperclip starts a new herdr-acp for every run and resumes the conversation with `session/load`. When herdr-acp exits (end of stdin or SIGTERM), the agent keeps running in its tab, and the next run reattaches to that same pane. `session/close` exits the agent and closes the tab. Add `--close-panes-on-exit` to the wrapper to close the tabs at the end of every run instead, which frees the agent processes between runs; the next run then resumes the transcript in a new tab.

## Options

| Option | Environment | Meaning |
|---|---|---|
| `--agent <claude\|pi>` | `HERDR_ACP_AGENT` | Agent to run (default `claude`) |
| `--workspace <label>` | `HERDR_ACP_WORKSPACE` | herdr workspace that hosts session tabs (default `acp`) |
| `--herdr-session <name>` | `HERDR_ACP_HERDR_SESSION` | Named herdr session |
| `--machine <label>` | `HERDR_ACP_MACHINE` | Saved herdr SSH machine |
| `--trust-folders` | `HERDR_ACP_TRUST_FOLDERS=1` | Accept the folder trust question when the client cannot be asked |
| `--close-panes-on-exit` | `HERDR_ACP_CLOSE_PANES_ON_EXIT=1` | Also close the tabs herdr-acp created when it exits. `session/close` always closes them |
| `--forward-env <list>` | `HERDR_ACP_FORWARD_ENV` | Variables forwarded even when protected (e.g. `ANTHROPIC_API_KEY`) |
| `--exclude-env <list>` | `HERDR_ACP_EXCLUDE_ENV` | Extra variables kept out of panes (`NAME*` matches a prefix) |
| `--start-timeout <ms>` | | Agent startup timeout (default 60000) |
| `-- <args>` | | Extra arguments for the agent CLI (e.g. `-- --model sonnet`) |

Panes receive the environment herdr-acp was started with, minus terminal variables (`PATH`, `TERM`, `SHELL`, `HERDR_*`, …) and the agent's protected variables (API keys, internal markers). When a live session is reused, the new environment reaches the agent's shell before the next command.

## Supported ACP surface

| Method or update | Claude Code | Pi |
|---|---|---|
| `session/new`, `load`, `resume`, `fork`, `list`, `close` | ✓ | ✓ |
| `session/prompt`, `cancel`, prompt queueing, `_session/steering` | ✓ | ✓ |
| Streaming | per paragraph | per token |
| Tool calls with diffs for edits | ✓ | ✓ |
| `session/request_permission` | Claude's own permission rules | mode `ask` |
| `AskUserQuestion` via `elicitation/create` forms | ✓ | — |
| Modes (`session/set_mode`) | default, acceptEdits, plan, auto, dontAsk, bypassPermissions¹ | default (auto), ask |
| Config options: mode, model, effort / thinking | ✓ (relaunch with `--resume`) | ✓ (mode live, others relaunch) |
| `usage_update`, token usage, available commands | ✓ | ✓ |
| Image prompts | ✓ | ✓ |

¹ `bypassPermissions` only when the agent is started with `--allow-dangerously-skip-permissions`.

A session can also be loaded while it is running in a herdr pane you started yourself: `session/list` shows live agents and stored transcripts.

## herdr extensions (`_meta.herdr`)

`initialize` announces them under `_meta.herdr`: `{ version, agent, extensions }`, each extension with a version number.

| Extension | Where | Shape |
|---|---|---|
| `sessionPlacement` | response `_meta` of `session/new`, `load`, `resume`, `fork` | `{ herdr: { paneId, tabId, ownsTab } }` |
| `sessionConfig` | request `_meta` of `session/new` | `{ herdr: { config: { mode?, model?, effort? } } }`, values from the session's config options; applied at launch; an unknown key or value fails with `-32602` before any tab is created |
| `permissionSuggestions` (Claude) | `_meta` of the `allow_always` permission option | `{ herdr: { suggestions: [{ ...Claude suggestion, destination, originalDestination?, path }] } }`; `userSettings` is always redirected to `localSettings` |
| `rateLimits` (Claude) | `_meta` of `session/prompt` responses | `{ herdr: { rateLimits } }`, as reported by Claude's status line |

`_session/steering` is announced separately as `_meta.steering.supported`.

## How it works

- **Placement**: each session gets a tab in the herdr workspace `acp`, created with the session's cwd and environment. The agent is started with `herdr agent start`.
- **Teardown**: on `session/close` or when herdr-acp exits (end of stdin, SIGINT, SIGTERM, SIGHUP), the agent is asked to exit (`/exit`, `/quit` for Pi; up to 5 s) and the tab herdr-acp created is closed. A pane you started yourself and attached with `session/load` is never closed.
- **Pane records**: herdr-acp remembers which pane it launched for each session (`~/.local/state/herdr-acp/panes/`). A later `session/load` or `session/resume`, even from a new herdr-acp process, reuses that pane: it reattaches to the running agent, or relaunches it with `--resume` if only the shell is left. A new tab is opened only when the pane is gone.
- **Prompts** are typed into the TUI with `herdr agent prompt`, exactly as you would.
- **Transcript**: herdr-acp tails the agent's JSONL session file and turns messages, tool calls and results into `session/update` notifications.
- **Structured callbacks**: Claude Code hooks (`PreToolUse`, `PermissionRequest`, `MessageDisplay`, `UserPromptSubmit`, `SessionStart`, `CwdChanged`, `FileChanged`) and a Pi extension call back into herdr-acp over a per-session unix socket (`~/.local/state/herdr-acp/s/`). This is how permissions, questions, streaming, modes and turn ends are handled without reading the screen.
- **Claude status line**: a wrapper status line forwards Claude's status JSON (context window, model, effort, plan usage limits) and then runs your own status line command unchanged.
- **Outside a turn**, the callbacks do nothing: if you type in the pane yourself, the agent behaves as usual.

## Global hooks

Sessions that you start by hand in herdr can be driven over ACP too, if the callbacks are installed globally:

```sh
herdr-acp install-hooks               # Claude Code: adds hooks to ~/.claude/settings.json (backup kept)
herdr-acp install-hooks --agent pi    # Pi: adds ~/.pi/agent/extensions/herdr-acp.js
herdr-acp uninstall-hooks [--agent pi]
```

The hooks exit immediately when no herdr-acp is attached to the session.

## Limitations

- Claude Code streams per paragraph, not per token: token deltas are not exposed in interactive mode.
- Changing the model or effort, and changing Claude's mode, relaunch the agent with `--resume` (about 5 seconds). The conversation is kept.
- Claude's `ExitPlanMode` approval cannot be answered by a hook: herdr-acp restarts Claude in the chosen mode and asks it to implement the approved plan.
- Answering Claude's folder trust dialog is the one remaining keystroke; its effect is verified in `~/.claude.json`.
- If the agent waits on a dialog no callback covers, herdr-acp logs it on stderr and waits; answer it in the pane.

## Development

```sh
npm install
npm test                      # unit tests (node:test, TypeScript run directly)
npm run build
npm run smoke -- --cwd /some/project --herdr-session test "Say hello"
```

The smoke script is an ACP client that drives herdr-acp end to end. It is best run against an isolated herdr server (`herdr --session test server`), started from a shell where no `CLAUDE_CODE_*` variables are set.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Alain Clément.
