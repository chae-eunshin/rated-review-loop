import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { begin, cancel, handleStop, rate, ready, submit } from "../src/cycle.ts";
import { sessionKey } from "../src/store.ts";
import { createRepo, failingChecks, passingChecks, type Repo } from "./helpers.ts";

const SESSION = "session-A";
const key = sessionKey(SESSION);
const finding = { file: "src/value.ts", line: 1, title: "Magic number", rule: "r", impact: "i", suggestion: "s" };

let repo: Repo;

beforeEach(() => {
  repo = createRepo();
});

afterEach(() => {
  repo.cleanup();
});

/** Takes a run through begin → edit → ready → Stop with passing checks. */
function reachReview(ctx = repo.context()) {
  const { runId } = begin(ctx, key, "change value");
  repo.write("src/value.ts", "export const value = 2;\n");
  ready(ctx, key, ["src/value.ts"]);
  const output = handleStop(ctx, { session_id: SESSION, stop_hook_active: false }, "claude", passingChecks);
  return { ctx, runId, output };
}

describe("review cycle", () => {
  it("requests a review only after checks pass, and records the reviewing client", () => {
    const { ctx, runId, output } = reachReview();
    expect(output.decision).toBe("block");
    expect(output.reason).toContain(`packet ${runId}`);
    const run = ctx.store.readRun(runId);
    expect(run.phase).toBe("awaiting-review");
    expect(run.reviewer).toEqual({ client: "claude", model: "unknown" });
    expect(run.changes).toEqual([
      { path: "src/value.ts", before: "export const value = 1;\n", after: "export const value = 2;\n" },
    ]);
  });

  it("does not request a review when a check fails", () => {
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "change value");
    repo.write("src/value.ts", "export const value = 2;\n");
    ready(ctx, key, ["src/value.ts"]);
    const output = handleStop(ctx, { session_id: SESSION }, "claude", failingChecks);
    expect(output.decision).toBeUndefined();
    expect(ctx.store.readRun(runId).phase).toBe("checks-failed");
  });

  it("keeps edits made before begin out of the reviewed change", () => {
    repo.write("src/value.ts", "export const value = 10;\n");
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "no-op");
    const result = ready(ctx, key, ["src/value.ts"]);
    expect(result.phase).toBe("skipped");
    expect(ctx.store.readRun(runId).files).toEqual([]);
  });

  it("skips binary and oversized files instead of failing", () => {
    writeFileSync(join(repo.root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(repo.root, "big.txt"), "x".repeat(3 * 1024 * 1024));
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "with assets");
    const files = Object.keys(ctx.store.readRun(runId).baseline);
    expect(files).toContain("src/value.ts");
    expect(files).not.toContain("logo.png");
    expect(files).not.toContain("big.txt");
  });

  it("marks the run stale when code changes between ready and Stop", () => {
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "change value");
    repo.write("src/value.ts", "export const value = 2;\n");
    ready(ctx, key, ["src/value.ts"]);
    repo.write("src/value.ts", "export const value = 3;\n");
    handleStop(ctx, { session_id: SESSION }, "claude", passingChecks);
    expect(ctx.store.readRun(runId).phase).toBe("stale");
  });

  it("does not block inside another hook's continuation", () => {
    const ctx = repo.context();
    begin(ctx, key, "change value");
    repo.write("src/value.ts", "export const value = 2;\n");
    ready(ctx, key, ["src/value.ts"]);
    const output = handleStop(ctx, { session_id: SESSION, stop_hook_active: true }, "claude", passingChecks);
    expect(output.decision).toBeUndefined();
  });

  it("refuses a second begin while a run is open, and allows it after cancel", () => {
    const ctx = repo.context();
    begin(ctx, key, "first");
    expect(() => begin(ctx, key, "second")).toThrow(/still implementing/);
    cancel(ctx, key);
    expect(() => begin(ctx, key, "second")).not.toThrow();
  });

  it("uses the transcript to learn the session model", () => {
    const transcript = join(repo.root, "transcript.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { model: "claude-test-1" } })}\n`);
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "change value");
    repo.write("src/value.ts", "export const value = 2;\n");
    ready(ctx, key, ["src/value.ts"]);
    handleStop(ctx, { session_id: SESSION, transcript_path: transcript }, "claude", passingChecks);
    expect(ctx.store.readRun(runId).reviewer).toEqual({ client: "claude", model: "claude-test-1" });
  });
});

describe("submit and rate", () => {
  it("writes findings to the committed ledger without source snapshots", () => {
    const { ctx, runId } = reachReview();
    const result = submit(ctx, runId, { summary: "ok", findings: [finding] });
    expect(result.evaluationQuestion).toContain("F1 “Magic number”");
    const ledgerFile = ctx.ledger.path(runId);
    const raw = readFileSync(ledgerFile, "utf8");
    expect(raw).not.toContain("export const value");
    expect(JSON.parse(raw)).toMatchObject({ skill: ctx.store.readRun(runId).skill, reviewer: { client: "claude" }, evaluations: [] });
  });

  it("rejects findings outside the change", () => {
    const { ctx, runId } = reachReview();
    expect(() => submit(ctx, runId, { summary: "ok", findings: [{ ...finding, line: 99 }] })).toThrow(/inside the change/);
    expect(() => submit(ctx, runId, { summary: "ok", findings: [{ ...finding, file: "other.ts" }] })).toThrow();
  });

  it("keeps rating history and validates labels", () => {
    const { ctx, runId } = reachReview();
    submit(ctx, runId, { summary: "ok", findings: [finding] });
    expect(() => rate(ctx, runId, "F1", "great", "", "owner")).toThrow(/useful/);
    expect(() => rate(ctx, runId, "F9", "useful", "", "owner")).toThrow(/No finding/);
    rate(ctx, runId, "F1", "deferred", "", "owner");
    rate(ctx, runId, "F1", "useful", "after discussion", "owner");
    expect(ctx.ledger.read(runId).evaluations.map((evaluation) => evaluation.label)).toEqual(["deferred", "useful"]);
  });

  it("does not create a ledger entry before the review completes", () => {
    const { ctx, runId } = reachReview();
    expect(existsSync(ctx.ledger.path(runId))).toBe(false);
  });
});

describe("rating question", () => {
  it("reminds once when the final message omits the question, then records it as missed", () => {
    const { ctx, runId } = reachReview();
    submit(ctx, runId, { summary: "ok", findings: [finding] });
    const first = handleStop(ctx, { session_id: SESSION, last_assistant_message: "done" }, "claude", passingChecks);
    expect(first.decision).toBe("block");
    const second = handleStop(ctx, { session_id: SESSION, last_assistant_message: "done" }, "claude", passingChecks);
    expect(second.decision).toBeUndefined();
    expect(ctx.store.readRun(runId).evaluationRequest?.status).toBe("missed");
  });

  it("accepts the question when it appears verbatim, ignoring whitespace", () => {
    const { ctx, runId } = reachReview();
    const { evaluationQuestion } = submit(ctx, runId, { summary: "ok", findings: [finding] });
    const message = `Report.\n\n${String(evaluationQuestion).replace(/ /g, "  ")}`;
    expect(handleStop(ctx, { session_id: SESSION, last_assistant_message: message }, "claude", passingChecks)).toEqual({});
    expect(ctx.store.readRun(runId).evaluationRequest?.status).toBe("asked");
  });

  it("does not ask when there are no findings", () => {
    const { ctx, runId } = reachReview();
    expect(submit(ctx, runId, { summary: "nothing", findings: [] }).evaluationQuestion).toBeNull();
  });
});

describe("skill version", () => {
  it("does not depend on tool code and returns to the same version when the skill is reverted", () => {
    const ctx = repo.context();
    const v1 = begin(ctx, key, "a").runId;
    cancel(ctx, key);
    repo.write("skill.md", "# Review skill v2\n");
    const v2 = begin(ctx, key, "b").runId;
    cancel(ctx, key);
    repo.write("skill.md", "# Review skill v1\n");
    const v3 = begin(ctx, key, "c").runId;
    const skill = (id: string) => ctx.store.readRun(id).skill;
    expect(skill(v1)).not.toBe(skill(v2));
    expect(skill(v1)).toBe(skill(v3));
  });
});
