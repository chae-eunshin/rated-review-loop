import type { z } from "zod";

import {
  CLIENTS,
  LABELS,
  type ChangeSchema,
  type CheckResultSchema,
  type EvaluationSchema,
  type FindingSchema,
  type HookEventSchema,
  type LedgerEntrySchema,
  type ReportedFindingSchema,
  type ReviewerSchema,
  type ReviewReportSchema,
  type RunSchema,
} from "./schemas.ts";

export { CLIENTS, LABELS, QUESTION_STATUSES, RUN_SCHEMA_VERSION } from "./schemas.ts";

/** How the owner judged a single finding. */
export type Label = (typeof LABELS)[number];

export function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

/** The coding agents whose sessions or CLIs can review. */
export type Client = (typeof CLIENTS)[number];

export function isClient(value: string): value is Client {
  return (CLIENTS as readonly string[]).includes(value);
}

export type Reviewer = z.infer<typeof ReviewerSchema>;
export type ReportedFinding = z.infer<typeof ReportedFindingSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type HookEvent = z.infer<typeof HookEventSchema>;
export type StopEvent = Extract<HookEvent, { hook_event_name: "Stop" }>;

/** One review cycle. Each group of phases carries exactly the data that exists at that point. */
export type Run = z.infer<typeof RunSchema>;
export type Phase = Run["phase"];

/**
 * The run narrowed to some phases. Several phases share one shape (ready, checking, checks-failed, stale,
 * skipped), so this intersects rather than `Extract`s: the shared shape is kept with `phase` narrowed.
 */
export type RunIn<P extends Phase> = Run & { phase: P };

export function inPhase<const P extends Phase>(run: Run, phases: readonly P[]): run is RunIn<P> {
  return (phases as readonly Phase[]).includes(run.phase);
}

/** Runs in these phases are over; `prune` may delete them. */
export const FINISHED_PHASES: ReadonlySet<string> = new Set<Phase>(["completed", "skipped", "cancelled"]);

export type CompletedRun = RunIn<"completed">;
export type QuestionStatus = NonNullable<CompletedRun["evaluationRequest"]>["status"];
