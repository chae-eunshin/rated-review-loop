import { z } from "zod";

/**
 * Every value this tool reads from outside its own process — hook events, review reports, run files,
 * ledger entries, transcripts — is parsed with one of these schemas. Types in `types.ts` are inferred
 * from them, so a shape is written once and the type, the runtime check and the JSON Schema given to
 * CLI reviewers cannot drift apart.
 */

export const LABELS = ["useful", "out-of-scope", "unsupported", "incorrect", "deferred"] as const;
export const CLIENTS = ["claude", "codex"] as const;

const text = z.string();
/** A refinement, not `.trim()`, so the stored value is unchanged and the JSON Schema stays a plain string. */
const nonEmpty = z.string().refine((value) => value.trim() !== "", "must not be empty");

export const ReviewerSchema = z.object({
  client: z.enum(CLIENTS),
  /** Model id reported by the client, or "unknown" when it cannot be observed. */
  model: text,
});

/** A finding as the reviewer writes it. */
export const ReportedFindingSchema = z.object({
  file: text,
  line: z.int().min(1),
  title: nonEmpty,
  rule: nonEmpty,
  impact: nonEmpty,
  suggestion: nonEmpty,
});

export const ReviewReportSchema = z.object({
  summary: nonEmpty,
  findings: z.array(ReportedFindingSchema),
});

/**
 * Given to `claude --json-schema` and `codex exec --output-schema`. Draft-07 because Claude rejects the
 * default draft 2020-12 `$schema`; Codex accepts both (checked with claude 2.1.323 and codex-cli 0.166.0).
 */
export const REPORT_JSON_SCHEMA = z.toJSONSchema(ReviewReportSchema, { target: "draft-07" });

export const FindingSchema = ReportedFindingSchema.extend({
  /** F1, F2, ... in report order. */
  id: text,
});

export const EvaluationSchema = z.object({
  findingId: text,
  label: z.enum(LABELS),
  note: text,
  at: text,
  by: text,
});

export const CheckResultSchema = z.object({
  command: text,
  exitCode: z.int().nullable(),
  durationMs: z.number(),
  output: text,
});

export const ChangeSchema = z.object({
  path: text,
  before: text.nullable(),
  after: text.nullable(),
});

export const RUN_SCHEMA_VERSION = 2;

const RunBaseSchema = z.object({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  id: text,
  key: text,
  task: text,
  skill: text,
  startedAt: text,
  /** Path → content id at `begin` (see `Snapshot`), not the content itself. */
  baseline: z.record(text, text),
  checks: z.array(CheckResultSchema),
  attempts: z.array(z.object({ at: text, checks: z.array(CheckResultSchema) })),
});

/** Implementing: only the baseline exists. */
const ImplementingRunSchema = RunBaseSchema.extend({ phase: z.literal("implementing") });

/** The files under review are fixed by `ready`. These phases differ in meaning, not in data. */
const PreparedFields = {
  files: z.array(text),
  changes: z.array(ChangeSchema),
  expectedFingerprint: text,
};
const PreparedRunSchema = RunBaseSchema.extend({
  phase: z.enum(["ready", "checking", "checks-failed", "stale", "skipped"]),
  ...PreparedFields,
});

/** Checks passed and a review was requested. A session reviewer is known now; a CLI reviewer only at submit. */
const AwaitingReviewRunSchema = RunBaseSchema.extend({
  phase: z.literal("awaiting-review"),
  ...PreparedFields,
  reviewRequestedAt: text,
  reviewer: ReviewerSchema.optional(),
});

export const QUESTION_STATUSES = ["pending", "reminded", "asked", "resolved", "missed"] as const;

const CompletedRunSchema = RunBaseSchema.extend({
  phase: z.literal("completed"),
  ...PreparedFields,
  reviewRequestedAt: text,
  reviewer: ReviewerSchema,
  summary: text,
  completedAt: text,
  findings: z.array(FindingSchema),
  evaluationRequest: z.object({ status: z.enum(QUESTION_STATUSES), text: text.optional(), at: text.optional() }).optional(),
});

/** Cancelled from any unfinished phase; whatever was prepared is no longer meaningful. */
const CancelledRunSchema = RunBaseSchema.extend({ phase: z.literal("cancelled") });

/** Local working state of one review cycle. Holds the reviewed source, so it is never committed. */
export const RunSchema = z.discriminatedUnion("phase", [
  ImplementingRunSchema,
  PreparedRunSchema,
  AwaitingReviewRunSchema,
  CompletedRunSchema,
  CancelledRunSchema,
]);

export const SessionBindingSchema = z.object({ runId: text });

/** The committed record of one completed review: findings and the owner's ratings, no source code. */
export const LedgerEntrySchema = z.object({
  schemaVersion: z.literal(1),
  runId: text,
  task: text,
  completedAt: text,
  skill: text,
  reviewer: ReviewerSchema,
  findings: z.array(FindingSchema.pick({ id: true, file: true, line: true, title: true, rule: true })),
  evaluations: z.array(EvaluationSchema),
});

/**
 * Hook events shared by Claude Code and Codex. Only the fields this tool uses are listed; others are ignored.
 * Codex sends `null` for an absent transcript or message, so those accept null as well as a missing key.
 */
export const HookEventSchema = z.discriminatedUnion("hook_event_name", [
  z.object({ hook_event_name: z.literal("SessionStart"), session_id: nonEmpty }),
  z.object({
    hook_event_name: z.literal("Stop"),
    session_id: nonEmpty,
    cwd: text.nullish(),
    stop_hook_active: z.boolean().nullish(),
    last_assistant_message: text.nullish(),
    transcript_path: text.nullish(),
  }),
]);

/** Transcript lines that carry a model: Claude Code assistant messages and Codex turn contexts. */
export const TranscriptModelSchema = z.union([
  z.object({ message: z.object({ model: nonEmpty }) }),
  z.object({ payload: z.object({ model: nonEmpty }) }),
]);

/** One-line description of the first problem, for error messages. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid value";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}
