import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { begin, cancel, handleStop, rate, ready, submit } from "../src/cycle.ts";
import { sessionKey } from "../src/store.ts";
import { createRepo, failingChecks, passingChecks, type Repo } from "./helpers.ts";

const SESSION = "session-A";
const key = sessionKey(SESSION);
const finding = { file: "src/value.ts", line: 1, title: "Magic number", rule: "r", impact: "i", suggestion: "s" };

let repo: Repo;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo.root, encoding: "utf8" }).trim();

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

  it("leaves binary and oversized files out of the review and reports them", () => {
    writeFileSync(join(repo.root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(repo.root, "big.txt"), "x".repeat(3 * 1024 * 1024));
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "with assets");
    writeFileSync(join(repo.root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x02]));
    writeFileSync(join(repo.root, "big.txt"), "y".repeat(3 * 1024 * 1024));
    repo.write("src/value.ts", "export const value = 2;\n");
    expect(ready(ctx, key, ["logo.png", "big.txt", "src/value.ts"])).toEqual({
      runId,
      phase: "ready",
      files: ["src/value.ts"],
      notReviewable: ["logo.png", "big.txt"],
    });
    expect(ctx.store.readRun(runId).changes?.map((change) => change.path)).toEqual(["src/value.ts"]);
  });

  it("skips the review when only unreviewable files changed", () => {
    const ctx = repo.context();
    begin(ctx, key, "replace logo");
    writeFileSync(join(repo.root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x03]));
    expect(ready(ctx, key, ["logo.png"])).toMatchObject({ phase: "skipped", files: [], notReviewable: ["logo.png"] });
  });

  it("stores content ids instead of source in the run file", () => {
    repo.write("notes/draft.ts", "export const draft = 'uncommitted';\n");
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "change value");
    const raw = readFileSync(ctx.store.runPath(runId), "utf8");
    expect(raw).not.toContain("export const");
    const { baseline } = ctx.store.readRun(runId);
    expect(baseline["src/value.ts"]).toBe(git("rev-parse", "HEAD:src/value.ts"));
  });

  it("keeps the begin-time content of files that were already dirty", () => {
    repo.write("src/value.ts", "export const value = 10;\n");
    repo.write("src/new.ts", "export const fresh = 1;\n");
    const ctx = repo.context();
    begin(ctx, key, "change both");
    repo.write("src/value.ts", "export const value = 20;\n");
    repo.write("src/new.ts", "export const fresh = 2;\n");
    const { runId } = ready(ctx, key, ["src/value.ts", "src/new.ts"]);
    expect(ctx.store.readRun(runId).changes).toEqual([
      { path: "src/value.ts", before: "export const value = 10;\n", after: "export const value = 20;\n" },
      { path: "src/new.ts", before: "export const fresh = 1;\n", after: "export const fresh = 2;\n" },
    ]);
  });

  it("treats a clean file that was edited and restored as unchanged", () => {
    const ctx = repo.context();
    begin(ctx, key, "no-op");
    repo.write("src/value.ts", "export const value = 2;\n");
    repo.write("src/value.ts", "export const value = 1;\n");
    expect(ready(ctx, key, ["src/value.ts"]).phase).toBe("skipped");
  });

  it("records added and deleted files with a null side", () => {
    const ctx = repo.context();
    begin(ctx, key, "move value");
    rmSync(join(repo.root, "src/value.ts"));
    repo.write("src/moved.ts", "export const value = 1;\n");
    const { runId } = ready(ctx, key, ["src/value.ts", "src/moved.ts"]);
    expect(ctx.store.readRun(runId).changes).toEqual([
      { path: "src/value.ts", before: "export const value = 1;\n", after: null },
      { path: "src/moved.ts", before: null, after: "export const value = 1;\n" },
    ]);
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

describe("prune", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("deletes old finished runs and their stored copies, and keeps open runs", () => {
    repo.write("src/value.ts", "export const value = 10;\n");
    const ctx = repo.context();
    const old = begin(ctx, key, "old").runId;
    cancel(ctx, key);
    const objects = readdirSync(join(repo.root, ".rated-review-loop/local/objects"));
    expect(objects).toHaveLength(1);
    const open = begin(ctx, sessionKey("session-B"), "open").runId;
    const later = Date.now() + 15 * DAY;
    // Both runs share the dirty file's copy, so it survives while the open run needs it.
    expect(ctx.store.prune(14, later)).toEqual({ runs: 1, objects: 0 });
    expect(existsSync(ctx.store.runPath(old))).toBe(false);
    expect(ctx.store.active(key)).toBeNull();
    expect(ctx.store.readRun(open).phase).toBe("implementing");
    cancel(ctx, sessionKey("session-B"));
    expect(ctx.store.prune(0, later + DAY)).toEqual({ runs: 1, objects: 1 });
  });

  it("keeps recent finished runs", () => {
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "recent");
    cancel(ctx, key);
    expect(ctx.store.prune(14)).toEqual({ runs: 0, objects: 0 });
    expect(existsSync(ctx.store.runPath(runId))).toBe(true);
  });

  it("ignores a run written by an older version instead of failing", () => {
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "v1");
    const path = ctx.store.runPath(runId);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), schemaVersion: 1 }));
    expect(ctx.store.active(key)).toBeNull();
    expect(() => begin(ctx, key, "v2")).not.toThrow();
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
