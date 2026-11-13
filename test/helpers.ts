import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseConfig, type Config } from "../src/config.ts";
import { createContext, type Context } from "../src/cycle.ts";
import { inPhase, type CheckResult, type LedgerEntry, type Phase, type Run, type RunIn } from "../src/types.ts";

/** Narrows a run read back from disk, failing the test with the actual phase when it is not one of `phases`. */
export function runIn<const P extends Phase>(run: Run, phases: readonly P[]): RunIn<P> {
  if (!inPhase(run, phases)) throw new Error(`Expected the run to be ${phases.join(" or ")}, but it is ${run.phase}.`);
  return run;
}

export interface Repo {
  root: string;
  write(path: string, content: string): void;
  context(overrides?: Record<string, unknown>): Context;
  cleanup(): void;
}

/** A throwaway git repository with one committed source file and a project skill. */
export function createRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "rated-review-loop-"));
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  execFileSync("git", ["init", "-q"], { cwd: root });
  write("src/value.ts", "export const value = 1;\n");
  write("skill.md", "# Review skill v1\n");
  write(".gitignore", ".rated-review-loop/local/\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: root });
  return {
    root,
    write,
    context: (overrides = {}) => createContext(root, parseConfig({ skill: "skill.md", checks: ["true"], ...overrides })),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const passingChecks = (_root: string, config: Config): CheckResult[] =>
  config.checks.map((command) => ({ command, exitCode: 0, durationMs: 1, output: "ok" }));

export const failingChecks = (_root: string, config: Config): CheckResult[] =>
  config.checks.map((command) => ({ command, exitCode: 1, durationMs: 1, output: "boom" }));

let counter = 0;

/** A ledger entry with `useful` and other ratings, timestamped in order. */
export function ledgerEntry(
  ratings: string[],
  { skill = "skill-a", client = "claude", model = "model-1" }: { skill?: string; client?: "claude" | "codex"; model?: string } = {},
): LedgerEntry {
  counter += 1;
  const runId = `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
  return {
    schemaVersion: 1,
    runId,
    task: "t",
    completedAt: new Date(counter * 1000).toISOString(),
    skill,
    reviewer: { client, model },
    findings: ratings.map((_, index) => ({ id: `F${index + 1}`, file: "a.ts", line: 1, title: "x", rule: "r" })),
    evaluations: ratings
      .map((label, index) => ({ findingId: `F${index + 1}`, label, note: "", at: new Date(counter * 1000 + index).toISOString(), by: "o" }))
      .filter((evaluation) => evaluation.label !== "unrated") as LedgerEntry["evaluations"],
  };
}
