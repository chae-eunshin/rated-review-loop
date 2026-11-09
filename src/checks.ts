import { spawnSync } from "node:child_process";

import type { Config } from "./config.ts";
import type { CheckResult } from "./types.ts";

export type CheckRunner = (root: string, config: Config) => CheckResult[];

/** Runs every configured command in the repository root through the shell. */
export const runChecks: CheckRunner = (root, config) =>
  config.checks.map((command) => {
    const start = Date.now();
    const result = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: "utf8",
      timeout: config.checkTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      command,
      exitCode: result.status,
      durationMs: Date.now() - start,
      output: `${result.stdout}${result.stderr}${result.error?.message ?? ""}`.slice(-16_000),
    };
  });

export function checksPassed(config: Config, checks: CheckResult[]): boolean {
  return checks.length === config.checks.length && checks.every((check) => check.exitCode === 0);
}
