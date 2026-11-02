import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Claude Code's status line input carries the account's rate limits
// (code.claude.com/docs/en/statusline): used_percentage from 0 to 100,
// resets_at in Unix epoch seconds. They are kept in one file for office's
// sober mode (office budget), merged across sessions.

export interface RateWindow {
  used_percentage: number;
  resets_at: number;
}

export interface RateLimitsFile {
  updated_at: string;
  source: string;
  rate_limits: Record<string, RateWindow>;
}

export const RATE_LIMITS_ENV = "OFFICE_RATE_LIMITS_FILE";
const WINDOWS = ["five_hour", "seven_day"] as const;
// Two readings of one window may disagree on resets_at by a few seconds.
const SAME_WINDOW_S = 600;

// $OFFICE_RATE_LIMITS_FILE, or $XDG_STATE_HOME/office/rate-limits.json; "off" turns the file off.
export function rateLimitsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = env[RATE_LIMITS_ENV]?.trim();
  if (set === "off") return null;
  if (set) return set;
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "office", "rate-limits.json");
}

function window(value: unknown): RateWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const w = value as Record<string, unknown>;
  const used = Number(w.used_percentage);
  const resets = Number(w.resets_at);
  if (w.used_percentage == null || w.resets_at == null || !Number.isFinite(used) || !Number.isFinite(resets)) return null;
  return { used_percentage: used, resets_at: resets };
}

// Within one window usage only grows: the higher reading wins. A later window replaces an earlier one.
// A window past its reset is dropped.
export function mergeWindows(old: Record<string, unknown> | undefined, fresh: Record<string, unknown>, nowS: number): Record<string, RateWindow> {
  const out: Record<string, RateWindow> = {};
  for (const name of WINDOWS) {
    const candidates = [window(old?.[name]), window(fresh[name])].filter((w): w is RateWindow => w !== null && w.resets_at > nowS);
    const [a, b] = candidates;
    if (!a) continue;
    if (!b) {
      out[name] = a;
      continue;
    }
    if (Math.abs(a.resets_at - b.resets_at) < SAME_WINDOW_S) {
      out[name] = { used_percentage: Math.max(a.used_percentage, b.used_percentage), resets_at: Math.max(a.resets_at, b.resets_at) };
    } else out[name] = a.resets_at > b.resets_at ? a : b;
  }
  return out;
}

// Merges the rate_limits of a status line input into the file, written atomically. Nothing to merge, nothing written.
export function recordRateLimits(input: Record<string, unknown>, path: string | null = rateLimitsPath(), now = new Date()): boolean {
  if (!path) return false;
  const fresh = input.rate_limits;
  if (typeof fresh !== "object" || fresh === null) return false;
  const nowS = Math.floor(now.getTime() / 1000);
  if (!WINDOWS.some((name) => window((fresh as Record<string, unknown>)[name]))) return false;
  let old: Record<string, unknown> | undefined;
  try {
    old = (JSON.parse(readFileSync(path, "utf8")) as Partial<RateLimitsFile>).rate_limits as Record<string, unknown> | undefined;
  } catch {}
  const file: RateLimitsFile = { updated_at: now.toISOString(), source: "statusline", rate_limits: mergeWindows(old, fresh as Record<string, unknown>, nowS) };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`);
  renameSync(tmp, path);
  return true;
}
