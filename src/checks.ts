import { spawnSync } from "node:child_process";

import type { Config } from "./config.ts";
import type { CheckResult } from "./types.ts";

export type CheckRunner = (root: string, config: Config) => CheckResult[];

/** Runs one shell command in the repository root, keeping the tail of its output. */
export function runCommand(root: string, command: string, timeoutMs: number, env: Record<string, string> = {}): CheckResult {
  const start = Date.now();
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return {
    command,
    exitCode: result.status,
    durationMs: Date.now() - start,
    output: `${result.stdout}${result.stderr}${result.error?.message ?? ""}`.slice(-16_000),
  };
}

/** Runs every configured check. All of them run, so one report shows every failure. */
export const runChecks: CheckRunner = (root, config) =>
  config.checks.map((command) => runCommand(root, command, config.checkTimeoutMs));

export function checksPassed(config: Config, checks: CheckResult[]): boolean {
  return checks.length === config.checks.length && checks.every((check) => check.exitCode === 0);
}

/** Runs the `begin` gates in order and returns the first failure, or null when all pass. */
export function firstFailingGate(root: string, config: Config, env: Record<string, string>): CheckResult | null {
  for (const command of config.gates.begin) {
    const result = runCommand(root, command, config.checkTimeoutMs, env);
    if (result.exitCode !== 0) return result;
  }
  return null;
}
