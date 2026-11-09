import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "../store.ts";
import { failure, REPORT_SCHEMA, type CliReviewer } from "./shared.ts";

const TIMEOUT_MS = 15 * 60_000;

/** Codex in exec mode with a read-only sandbox. The schema and the last message go through files. */
export const codexCli: CliReviewer = {
  client: "codex",
  review(request, spawn) {
    const schemaPath = join(request.workDir, "report.schema.json");
    const outputPath = join(request.workDir, "codex-last-message.json");
    writeJsonAtomic(schemaPath, REPORT_SCHEMA);
    const args = ["exec", "--sandbox", "read-only", "--output-schema", schemaPath, "--output-last-message", outputPath];
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
    // codex exec does not report the default model, so only an explicitly configured one is known.
    return { report, reviewer: { client: "codex", model: request.model ?? "unknown" } };
  },
};
