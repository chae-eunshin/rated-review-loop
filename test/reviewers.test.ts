import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { begin, handleStop, ready } from "../src/cycle.ts";
import { reviewWithCli } from "../src/review.ts";
import { codexSessionModel } from "../src/reviewers/codex.ts";
import type { Spawn } from "../src/reviewers/index.ts";
import { sessionKey } from "../src/store.ts";
import { modelFromTranscript } from "../src/transcript.ts";
import { createRepo, passingChecks, type Repo } from "./helpers.ts";

const SESSION = "session-cli";
const key = sessionKey(SESSION);
const report = {
  summary: "ok",
  findings: [{ file: "src/value.ts", line: 1, title: "t", rule: "r", impact: "i", suggestion: "s" }],
};

let repo: Repo;

beforeEach(() => {
  repo = createRepo();
});

afterEach(() => {
  repo.cleanup();
});

function awaitingReview(mode: "claude-cli" | "codex-cli", model?: string) {
  const ctx = repo.context({ reviewer: { mode, ...(model ? { model } : {}) } });
  const { runId } = begin(ctx, key, "change value");
  repo.write("src/value.ts", "export const value = 2;\n");
  ready(ctx, key, ["src/value.ts"]);
  const output = handleStop(ctx, { session_id: SESSION }, "claude", passingChecks);
  return { ctx, runId, output };
}

describe("CLI reviewers", () => {
  it("asks the session agent to run the CLI review instead of reviewing itself", () => {
    const { output, runId } = awaitingReview("claude-cli");
    expect(output.reason).toContain(`review ${runId}`);
  });

  it("reads Claude's structured output and model", () => {
    const { ctx, runId } = awaitingReview("claude-cli");
    const calls: { command: string; args: string[]; input: string }[] = [];
    const spawn: Spawn = (command, args, { input }) => {
      calls.push({ command, args, input });
      return { status: 0, stderr: "", stdout: JSON.stringify({ structured_output: report, modelUsage: { "claude-x": {} } }) };
    };
    const result = reviewWithCli(ctx, runId, spawn);
    expect(result.findings).toHaveLength(1);
    expect(ctx.ledger.read(runId).reviewer).toEqual({ client: "claude", model: "claude-x" });
    expect(calls[0]?.command).toBe("claude");
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["-p", "--json-schema", "--disallowedTools", "Edit"]));
    expect(calls[0]?.input).toContain("# Review skill v1");
  });

  it("records the reported model id rather than the configured alias", () => {
    const { ctx, runId } = awaitingReview("claude-cli", "haiku");
    const modelUsage = { "claude-helper": { outputTokens: 5 }, "claude-haiku-full-id": { outputTokens: 900 } };
    const spawn: Spawn = () => ({ status: 0, stderr: "", stdout: JSON.stringify({ structured_output: report, modelUsage }) });
    reviewWithCli(ctx, runId, spawn);
    expect(ctx.ledger.read(runId).reviewer.model).toBe("claude-haiku-full-id");
  });

  it("runs Codex read-only and reads the last message file", () => {
    const { ctx, runId } = awaitingReview("codex-cli", "codex-model");
    const spawn: Spawn = (_command, args) => {
      const output = args[args.indexOf("--output-last-message") + 1];
      if (output === undefined) throw new Error("missing --output-last-message");
      writeFileSync(output, JSON.stringify(report));
      expect(args).toEqual(expect.arrayContaining(["exec", "--sandbox", "read-only", "--model", "codex-model", "-"]));
      return { status: 0, stdout: "", stderr: "" };
    };
    reviewWithCli(ctx, runId, spawn);
    expect(ctx.ledger.read(runId).reviewer).toEqual({ client: "codex", model: "codex-model" });
  });

  it("surfaces CLI failures and leaves the run awaiting review", () => {
    const { ctx, runId } = awaitingReview("claude-cli");
    const spawn: Spawn = () => ({ status: 1, stdout: "", stderr: "not logged in" });
    expect(() => reviewWithCli(ctx, runId, spawn)).toThrow(/claude reviewer failed.*not logged in/);
    expect(ctx.store.readRun(runId).phase).toBe("awaiting-review");
  });

  it("rejects a report that does not match the change", () => {
    const { ctx, runId } = awaitingReview("claude-cli");
    const bad = { ...report, findings: [{ ...report.findings[0], line: 500 }] };
    const spawn: Spawn = () => ({ status: 0, stderr: "", stdout: JSON.stringify({ structured_output: bad }) });
    expect(() => reviewWithCli(ctx, runId, spawn)).toThrow(/inside the change/);
  });
});

describe("codexSessionModel", () => {
  it("finds the session log by thread id and reads its model", () => {
    const home = join(repo.root, "codex-home");
    mkdirSync(join(home, "sessions/2026/11/09"), { recursive: true });
    writeFileSync(
      join(home, "sessions/2026/11/09/rollout-2026-11-09T23-00-00-thread-123.jsonl"),
      `${JSON.stringify({ type: "turn_context", payload: { model: "codex-real" } })}\n`,
    );
    expect(codexSessionModel("thread-123", home)).toBe("codex-real");
    expect(codexSessionModel("thread-404", home)).toBe("unknown");
    expect(codexSessionModel(undefined, home)).toBe("unknown");
  });
});

describe("modelFromTranscript", () => {
  it("reads Claude Code and Codex transcripts and tolerates a partial last line", () => {
    const path = join(repo.root, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "turn_context", payload: { model: "codex-model" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-model" } }),
        '{"type":"assistant","message":{"model":"cut',
      ].join("\n"),
    );
    expect(modelFromTranscript(path)).toBe("claude-model");
    expect(modelFromTranscript(undefined)).toBe("unknown");
  });
});
