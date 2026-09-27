const TERMINAL_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|PWD|OLDPWD|SHLVL|_|LANG|LC_\w+|TERM|TERM_\w+|COLORTERM|TMUX|TMUX_PANE|STY|LINES|COLUMNS|PS1|PROMPT|SSH_TTY|HERDR_\w*|ITERM_\w+|WEZTERM_\w+|KITTY_\w+|GHOSTTY_\w+|ALACRITTY_\w+|VSCODE_\w+|__CF\w*|XPC_\w+|Apple_\w+)$/;

export type PaneEnvOptions = {
  protectedEnv: RegExp;
  include: string[];
  exclude: string[];
};

export function paneEnv(env: NodeJS.ProcessEnv, options: PaneEnvOptions): Record<string, string> {
  const matches = (key: string, patterns: string[]) =>
    patterns.some((pattern) => (pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern));
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const forced = options.include.includes(key);
    const blocked = TERMINAL_ENV.test(key) || options.protectedEnv.test(key) || matches(key, options.exclude);
    if (forced || !blocked) selected[key] = value;
  }
  return selected;
}

export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
