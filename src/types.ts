/** How the owner judged a single finding. */
export const LABELS = ["useful", "out-of-scope", "unsupported", "incorrect", "deferred"] as const;
export type Label = (typeof LABELS)[number];

export function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

/** The coding agents whose sessions or CLIs can review. */
export const CLIENTS = ["claude", "codex"] as const;
export type Client = (typeof CLIENTS)[number];

export function isClient(value: string): value is Client {
  return (CLIENTS as readonly string[]).includes(value);
}

export interface Reviewer {
  client: Client;
  /** Model id reported by the client, or "unknown" when it cannot be observed. */
  model: string;
}

/** A finding as the reviewer writes it. */
export interface ReportedFinding {
  file: string;
  line: number;
  title: string;
  rule: string;
  impact: string;
  suggestion: string;
}

export interface ReviewReport {
  summary: string;
  findings: ReportedFinding[];
}

export interface Finding extends ReportedFinding {
  /** F1, F2, ... in report order. */
  id: string;
}

export interface Evaluation {
  findingId: string;
  label: Label;
  note: string;
  at: string;
  by: string;
}

export interface CheckResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface Change {
  path: string;
  before: string | null;
  after: string | null;
}

export type Phase =
  | "implementing"
  | "ready"
  | "checking"
  | "checks-failed"
  | "stale"
  | "awaiting-review"
  | "completed"
  | "skipped"
  | "cancelled";

export type QuestionStatus = "pending" | "reminded" | "asked" | "resolved" | "missed";

/** Local working state of one review cycle. Holds source snapshots, so it is never committed. */
export interface Run {
  schemaVersion: 1;
  id: string;
  key: string;
  task: string;
  phase: Phase;
  skill: string;
  startedAt: string;
  baseline: Record<string, string>;
  files: string[];
  expectedFingerprint?: string;
  checks: CheckResult[];
  attempts: { at: string; checks: CheckResult[] }[];
  changes?: Change[];
  reviewer?: Reviewer;
  reviewRequestedAt?: string;
  completedAt?: string;
  summary?: string;
  findings: Finding[];
  evaluationRequest?: { status: QuestionStatus; text?: string; at?: string };
}

/** The committed record of one completed review: findings and the owner's ratings, no source code. */
export interface LedgerEntry {
  schemaVersion: 1;
  runId: string;
  task: string;
  completedAt: string;
  skill: string;
  reviewer: Reviewer;
  findings: Pick<Finding, "id" | "file" | "line" | "title" | "rule">[];
  evaluations: Evaluation[];
}
