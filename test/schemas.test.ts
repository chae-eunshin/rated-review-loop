import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { begin } from "../src/cycle.ts";
import { REPORT_SCHEMA } from "../src/reviewers/index.ts";
import { HookEventSchema } from "../src/schemas.ts";
import { sessionKey } from "../src/store.ts";
import { createRepo, ledgerEntry, type Repo } from "./helpers.ts";

const key = sessionKey("schema-session");

let repo: Repo;
beforeEach(() => {
  repo = createRepo();
});
afterEach(() => {
  repo.cleanup();
});

describe("report JSON Schema", () => {
  it("declares draft-07, which both claude --json-schema and codex --output-schema accept", () => {
    // Claude rejects the draft 2020-12 $schema zod emits by default.
    expect(REPORT_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("forbids extra properties and requires every field, as Codex structured output needs", () => {
    const finding = (REPORT_SCHEMA.properties?.findings as { items: Record<string, unknown> }).items;
    expect(REPORT_SCHEMA.additionalProperties).toBe(false);
    expect(REPORT_SCHEMA.required).toEqual(["summary", "findings"]);
    expect(finding.additionalProperties).toBe(false);
    expect(finding.required).toEqual(["file", "line", "title", "rule", "impact", "suggestion"]);
  });
});

describe("hook events", () => {
  it("accepts Codex's null transcript and message", () => {
    const event = HookEventSchema.parse({
      hook_event_name: "Stop",
      session_id: "s",
      transcript_path: null,
      last_assistant_message: null,
      turn_id: "ignored",
    });
    expect(event).toEqual({ hook_event_name: "Stop", session_id: "s", transcript_path: null, last_assistant_message: null });
  });

  it("rejects a Stop event without a session id", () => {
    expect(HookEventSchema.safeParse({ hook_event_name: "Stop", session_id: "" }).success).toBe(false);
    expect(HookEventSchema.safeParse({ hook_event_name: "Stop" }).success).toBe(false);
  });
});

describe("files read back from disk", () => {
  it("names a damaged run file instead of trusting it", () => {
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "task");
    const path = ctx.store.runPath(runId);
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, id: runId, phase: "completed" }));
    expect(() => ctx.store.readRun(runId)).toThrow(/is damaged \(.+\)\. Delete .+ and begin a new run/);
  });

  it("still reads version 2 runs written before phases were split into shapes", () => {
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "task");
    const current = ctx.store.readRun(runId);
    // The earlier writer kept files and findings on every phase, including implementing and cancelled.
    for (const phase of ["implementing", "cancelled"] as const) {
      writeFileSync(ctx.store.runPath(runId), JSON.stringify({ ...current, phase, files: [], findings: [] }));
      expect(ctx.store.readRun(runId)).toEqual({ ...current, phase });
    }
  });

  it("treats a run from another schema version as absent, so a new run can begin", () => {
    const ctx = repo.context();
    const { runId } = begin(ctx, key, "task");
    writeFileSync(ctx.store.runPath(runId), JSON.stringify({ schemaVersion: 1, id: runId, phase: "ready" }));
    expect(ctx.store.active(key)).toBeNull();
    expect(() => begin(ctx, key, "next task")).not.toThrow();
  });

  it("names an invalid ledger entry instead of skewing statistics", () => {
    const ctx = repo.context();
    const entry = ledgerEntry(["useful"]);
    // Written as raw JSON, the way a hand edit or a bad merge would leave it.
    const edited = JSON.stringify(entry).replace('"label":"useful"', '"label":"great"');
    const path = ctx.ledger.path(entry.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, edited);
    expect(() => ctx.ledger.all()).toThrow(/Ledger entry .+ is invalid \(evaluations\.0\.label/);
  });
});
