import { spawnSync } from "node:child_process";

import type { Client } from "../types.ts";
import { claudeCli } from "./claude.ts";
import { codexCli } from "./codex.ts";
import type { CliReviewer, Spawn } from "./shared.ts";

export const CLI_REVIEWERS: Record<Client, CliReviewer> = { claude: claudeCli, codex: codexCli };

export const spawnProcess: Spawn = (command, args, { cwd, input, timeoutMs }) => {
  const result = spawnSync(command, args, { cwd, input, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ...(result.error ? { error: result.error } : {}) };
};

export { reviewPrompt, REPORT_SCHEMA } from "./shared.ts";
export type { CliReviewer, ReviewRequest, ReviewResult, Spawn, SpawnResult } from "./shared.ts";
