import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "../store.ts";
import { modelFromTranscript } from "../transcript.ts";
import { failure, REPORT_SCHEMA, type CliReviewer } from "./shared.ts";

const TIMEOUT_MS = 15 * 60_000;

/** The thread id from `codex exec --json` events; its session log is named after it. */
function threadId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
    } catch {
      // Non-JSON lines are progress output.
    }
  }
  return undefined;
}

/**
 * `codex exec` does not print the model it used, but its session log records it.
 * Logs live under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl.
 */
export function codexSessionModel(id: string | undefined, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string {
  const sessions = join(codexHome, "sessions");
  if (id === undefined || !existsSync(sessions)) return "unknown";
  const file = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find((name) => name.endsWith(`${id}.jsonl`));
  return file === undefined ? "unknown" : modelFromTranscript(join(sessions, file));
}

/** Codex in exec mode with a read-only sandbox. The schema and the last message go through files. */
export const codexCli: CliReviewer = {
  client: "codex",
  review(request, spawn) {
    const schemaPath = join(request.workDir, "report.schema.json");
    const outputPath = join(request.workDir, "codex-last-message.json");
    writeJsonAtomic(schemaPath, REPORT_SCHEMA);
    const args = ["exec", "--json", "--sandbox", "read-only", "--output-schema", schemaPath, "--output-last-message", outputPath];
    if (request.model !== undefined) args.push("--model", request.model);
    // "-" reads the prompt from stdin, which avoids argument length limits for large skills.
    args.push("-");
    const result = spawn("codex", args, { cwd: request.root, input: request.prompt, timeoutMs: TIMEOUT_MS });
    if (result.status !== 0) throw failure("codex", result);
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(outputPath, "utf8"));
    } catch {
      throw failure("codex", { ...result, stderr: "The last message was not the expected JSON report." });
    }
    // Prefer the model Codex actually ran over the configured alias, as for Claude.
    const observed = codexSessionModel(threadId(result.stdout));
    return { report, reviewer: { client: "codex", model: observed !== "unknown" ? observed : (request.model ?? "unknown") } };
  },
};
