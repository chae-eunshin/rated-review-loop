import { failure, REPORT_SCHEMA, type CliReviewer } from "./shared.ts";

const TIMEOUT_MS = 15 * 60_000;

/**
 * The model that wrote the review. Prefer the id Claude reports over the configured alias ("haiku"),
 * so an alias and its full id do not split statistics. Helper models may also appear; the one that
 * produced the most output is the reviewer.
 */
function mainModel(usage: Record<string, unknown> | undefined): string | undefined {
  let best: { model: string; output: number } | undefined;
  for (const [model, value] of Object.entries(usage ?? {})) {
    const output = (value as { outputTokens?: unknown } | null)?.outputTokens;
    const tokens = typeof output === "number" ? output : 0;
    if (!best || tokens > best.output) best = { model, output: tokens };
  }
  return best?.model;
}

/** Claude Code in print mode. Structured output arrives in `structured_output`, the model in `modelUsage`. */
export const claudeCli: CliReviewer = {
  client: "claude",
  review(request, spawn) {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(REPORT_SCHEMA),
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ];
    if (request.model !== undefined) args.push("--model", request.model);
    const result = spawn("claude", args, { cwd: request.root, input: request.prompt, timeoutMs: TIMEOUT_MS });
    if (result.status !== 0) throw failure("claude", result);
    let output: { is_error?: boolean; structured_output?: unknown; modelUsage?: Record<string, unknown>; result?: unknown };
    try {
      output = JSON.parse(result.stdout) as typeof output;
    } catch {
      throw failure("claude", { ...result, stderr: `Unexpected output: ${result.stdout.slice(0, 500)}` });
    }
    if (output.is_error === true || output.structured_output === undefined) {
      throw failure("claude", { ...result, stderr: `No structured output: ${JSON.stringify(output.result ?? null).slice(0, 500)}` });
    }
    return {
      report: output.structured_output,
      reviewer: { client: "claude", model: mainModel(output.modelUsage) ?? request.model ?? "unknown" },
    };
  },
};
