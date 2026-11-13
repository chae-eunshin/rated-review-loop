import { randomUUID } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";

import { checksPassed, runChecks, type CheckRunner } from "./checks.ts";
import { clientOfMode, skillPath, type Config } from "./config.ts";
import {
  captureBaseline,
  fingerprint,
  Ledger,
  LocalStore,
  NotReviewableError,
  readBaselineText,
  readWorkingText,
  sessionKey,
  skillVersion,
  snapshot,
} from "./store.ts";
import { describeIssue, ReviewReportSchema } from "./schemas.ts";
import { modelFromTranscript } from "./transcript.ts";
import {
  FINISHED_PHASES,
  inPhase,
  isLabel,
  LABELS,
  RUN_SCHEMA_VERSION,
  type Change,
  type Client,
  type CompletedRun,
  type Finding,
  type LedgerEntry,
  type ReviewReport,
  type Reviewer,
  type Run,
  type RunIn,
  type StopEvent,
} from "./types.ts";

export type { StopEvent } from "./types.ts";

/** What the Stop handling reads from a Stop event; the event name was already used to route it here. */
export type StopInput = Omit<StopEvent, "hook_event_name">;

export const BIN = "npx rated-review-loop";

export interface Context {
  root: string;
  config: Config;
  store: LocalStore;
  ledger: Ledger;
}

export function createContext(root: string, config: Config): Context {
  return { root, config, store: new LocalStore(root, config), ledger: new Ledger(root, config) };
}

/** What a hook may return. Field names follow the shared Claude Code / Codex hook contract. */
export interface HookOutput {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: "SessionStart"; additionalContext: string };
}

/** Phases whose files under review are fixed but no review was requested yet. */
type PreparedRun = RunIn<"ready" | "checking" | "checks-failed" | "stale" | "skipped">;
/** Every run that went through `ready`, so it has a change set and a fingerprint. */
type ReadiedRun = PreparedRun | RunIn<"awaiting-review" | "completed">;

/** The fields every phase has. Moving to another group of phases starts from these, so nothing stale carries over. */
function base(run: Run): Omit<RunIn<"implementing">, "phase"> {
  const { schemaVersion, id, key, task, skill, startedAt, baseline, checks, attempts } = run;
  return { schemaVersion, id, key, task, skill, startedAt, baseline, checks, attempts };
}

const now = (): string => new Date().toISOString();

/** Finished runs older than this are deleted from local storage by `begin` and `prune`. The ledger is never pruned. */
export const PRUNE_AFTER_DAYS = 14;

export function begin(ctx: Context, key: string, task: string): { runId: string; phase: string } {
  if (!task.trim()) throw new Error("A task description is required.");
  const previous = ctx.store.active(key);
  if (previous && !FINISHED_PHASES.has(previous.phase)) {
    throw new Error(`Run ${previous.id} is still ${previous.phase}: resume it or cancel it first.`);
  }
  ctx.store.prune(PRUNE_AFTER_DAYS);
  const run: Run = {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: randomUUID(),
    key,
    task,
    phase: "implementing",
    skill: skillVersion(ctx.root, ctx.config),
    startedAt: now(),
    // Files that were already dirty are part of the baseline, so earlier human edits are not attributed to the AI.
    baseline: captureBaseline(ctx.root, ctx.config, ctx.store),
    checks: [],
    attempts: [],
  };
  ctx.store.saveRun(run);
  ctx.store.bind(key, run.id);
  return { runId: run.id, phase: run.phase };
}

export interface ReadyResult {
  runId: string;
  phase: string;
  files: string[];
  /** Changed files left out of the review because they are binary or larger than 2 MB. */
  notReviewable: string[];
}

export function ready(ctx: Context, key: string, files: string[]): ReadyResult {
  const run = ctx.store.active(key);
  if (!run || !inPhase(run, ["implementing", "checks-failed", "stale"])) {
    throw new Error("ready is only valid after begin, while implementing.");
  }
  if (!files.length) throw new Error("List the files you implemented.");
  const current = snapshot(ctx.root, ctx.config);
  const selected = [...new Set(files)];
  const unknown = selected.find((path) => !(path in current) && !(path in run.baseline));
  if (unknown !== undefined) throw new Error(`Not in the review scope: ${unknown}`);
  // Only the files under review are read, and the fingerprint check at Stop guarantees they are what gets checked.
  const changes: Change[] = [];
  const notReviewable: string[] = [];
  for (const path of selected.filter((candidate) => current[candidate] !== run.baseline[candidate])) {
    const change = reviewableChange(ctx, run, path);
    if (change === null) notReviewable.push(path);
    else changes.push(change);
  }
  const next: PreparedRun = {
    ...base(run),
    phase: changes.length ? "ready" : "skipped",
    files: changes.map((change) => change.path),
    changes,
    expectedFingerprint: fingerprint(current),
  };
  ctx.store.saveRun(next);
  return { runId: next.id, phase: next.phase, files: next.files, notReviewable };
}

/** The change to review, or `null` when either side is binary or too large to review. */
function reviewableChange(ctx: Context, run: Run, path: string): Change | null {
  try {
    return {
      path,
      before: readBaselineText(ctx.root, ctx.store, path, run.baseline[path]),
      after: readWorkingText(ctx.root, path),
    };
  } catch (error) {
    if (error instanceof NotReviewableError) return null;
    throw error;
  }
}

/** Deletes local runs that finished more than `days` ago and the stored file copies only they used. */
export function prune(ctx: Context, days = PRUNE_AFTER_DAYS): { runs: number; objects: number } {
  if (!Number.isFinite(days) || days < 0) throw new Error("--days must be zero or a positive number.");
  return ctx.store.prune(days);
}

function changed(ctx: Context, run: ReadiedRun): boolean {
  return (
    fingerprint(snapshot(ctx.root, ctx.config)) !== run.expectedFingerprint ||
    skillVersion(ctx.root, ctx.config) !== run.skill
  );
}

export function handleStop(ctx: Context, event: StopInput, client: Client, check: CheckRunner = runChecks): HookOutput {
  const key = sessionKey(event.session_id);
  const run = ctx.store.active(key);
  if (run?.phase === "completed") return ensureQuestion(ctx, run, event);
  if (run?.phase !== "ready") return {};
  // Do not block again inside a continuation another Stop hook started.
  if (event.stop_hook_active) return { systemMessage: "Review pending: it will run at the end of the next turn." };
  const lock = ctx.store.lockPath(run.id);
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { systemMessage: `Checks for run ${run.id} are already running or were interrupted. Inspect it with status.` };
    }
    throw error;
  }
  try {
    // Re-read under the lock so duplicate hook registrations check and request review only once.
    const latest = ctx.store.active(key);
    if (latest?.id !== run.id || latest.phase !== "ready") return {};
    return verifyAndRequestReview(ctx, latest, event, client, check);
  } finally {
    rmdirSync(lock);
  }
}

function verifyAndRequestReview(
  ctx: Context,
  run: PreparedRun,
  event: StopInput,
  client: Client,
  check: CheckRunner,
): HookOutput {
  if (changed(ctx, run)) {
    run.phase = "stale";
    ctx.store.saveRun(run);
    return { systemMessage: "Code or skill changed after ready, so review was skipped. Check the result and run ready again." };
  }
  // A failed or interrupted check is never retried automatically.
  run.phase = "checking";
  ctx.store.saveRun(run);
  run.checks = check(ctx.root, ctx.config);
  run.attempts.push({ at: now(), checks: run.checks });
  if (ctx.store.readRun(run.id).phase !== "checking") {
    return { systemMessage: "The run was closed while checks were running; it is not reactivated." };
  }
  const stale = fingerprint(snapshot(ctx.root, ctx.config)) !== run.expectedFingerprint;
  if (stale || !checksPassed(ctx.config, run.checks)) {
    run.phase = stale ? "stale" : "checks-failed";
    ctx.store.saveRun(run);
    return {
      systemMessage: `Review skipped: ${run.phase}. Check results: ${BIN} status ${run.key}. Do not report the work as done; look at the failing checks.`,
    };
  }
  const cliClient = clientOfMode(ctx.config.reviewer.mode);
  const next: RunIn<"awaiting-review"> = {
    ...run,
    phase: "awaiting-review",
    reviewRequestedAt: now(),
    // A session reviewer is the agent in this hook; a CLI reviewer is only known when it reports.
    ...(cliClient === null ? { reviewer: { client, model: modelFromTranscript(event.transcript_path) } } : {}),
  };
  ctx.store.saveRun(next);
  return { decision: "block", reason: reviewRequest(ctx, next, cliClient) };
}

function reviewRequest(ctx: Context, run: Pick<Run, "id">, cliClient: Client | null): string {
  if (cliClient !== null) {
    return [
      `Checks passed. Run \`${BIN} review ${run.id}\`; it asks ${cliClient} to review the change and records the findings.`,
      "Do not modify code. Report the findings with their ids and evidence to the user.",
      "If the command prints an evaluationQuestion, end your final message with it verbatim.",
    ].join(" ");
  }
  const guidelines = ctx.config.guidelines.length ? ` Project guidelines: ${ctx.config.guidelines.join(", ")}.` : "";
  return [
    `Checks passed. Read ${skillPath(ctx.root, ctx.config)} and review the change in \`${BIN} packet ${run.id}\`.${guidelines}`,
    `Write findings in language "${ctx.config.language}". Do not modify code.`,
    `Save the result JSON and record it with \`${BIN} submit ${run.id} <file>\` (an empty findings array if nothing is well-founded).`,
    "Then report the findings to the user and end your final message with the evaluationQuestion from the submit output, verbatim.",
    "This request is sent once for this run.",
  ].join(" ");
}

export function packet(ctx: Context, id: string): object {
  const run = ctx.store.readRun(id);
  return {
    runId: run.id,
    task: run.task,
    phase: run.phase,
    skill: run.skill,
    language: ctx.config.language,
    guidelines: ctx.config.guidelines,
    changes: "changes" in run ? run.changes : [],
    checks: run.checks.map(({ command, exitCode }) => ({ command, exitCode })),
  };
}

/** Checks the shape with the shared schema, then what a schema cannot know: that each finding points into the change. */
export function validateReport(run: Run, report: unknown): ReviewReport {
  const parsed = ReviewReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(
      `The report is invalid (${describeIssue(parsed.error)}). It needs a summary and findings with file, line, title, rule, impact, suggestion.`,
    );
  }
  const changes = "changes" in run ? run.changes : [];
  for (const finding of parsed.data.findings) {
    const change = changes.find((candidate) => candidate.path === finding.file);
    const lines = (change?.after ?? change?.before ?? "").split("\n").length;
    if (!change || finding.line > lines) {
      throw new Error(`Finding at ${finding.file}:${finding.line} is not inside the change under review.`);
    }
  }
  return parsed.data;
}

export function evaluationQuestion(run: Pick<CompletedRun, "id" | "findings">, entry: Pick<LedgerEntry, "evaluations">): string | null {
  const pending = run.findings.filter((finding) => !entry.evaluations.some((item) => item.findingId === finding.id));
  if (!pending.length) return null;
  const list = pending.map((finding) => `${finding.id} “${finding.title}”`).join(", ");
  return `Rate the review (${run.id}): ${list} — answer each with ${LABELS.join(" / ")}.`;
}

export interface SubmitResult {
  runId: string;
  findings: Finding[];
  evaluationQuestion: string | null;
}

export function submit(ctx: Context, id: string, report: unknown, reviewer?: Reviewer): SubmitResult {
  const run = ctx.store.readRun(id);
  if (run.phase !== "awaiting-review") throw new Error("This run is not awaiting review.");
  if (changed(ctx, run)) {
    const { files, changes, expectedFingerprint } = run;
    ctx.store.saveRun({ ...base(run), phase: "stale", files, changes, expectedFingerprint });
    throw new Error("Code changed during the review. Run ready again.");
  }
  const valid = validateReport(run, report);
  const by = reviewer ?? run.reviewer;
  if (!by) throw new Error("The reviewer of this run is unknown.");
  const findings: Finding[] = valid.findings.map(({ file, line, title, rule, impact, suggestion }, index) => ({
    id: `F${index + 1}`,
    file,
    line,
    title,
    rule,
    impact,
    suggestion,
  }));
  const completedAt = now();
  const entry: LedgerEntry = {
    schemaVersion: 1,
    runId: run.id,
    task: run.task,
    completedAt,
    skill: run.skill,
    reviewer: by,
    findings: findings.map(({ id: findingId, file, line, title, rule }) => ({ id: findingId, file, line, title, rule })),
    evaluations: [],
  };
  const question = evaluationQuestion({ id: run.id, findings }, entry);
  const completed: CompletedRun = {
    ...run,
    phase: "completed",
    reviewer: by,
    summary: valid.summary,
    completedAt,
    findings,
    ...(question !== null ? { evaluationRequest: { status: "pending", text: question } } : {}),
  };
  ctx.ledger.write(entry);
  ctx.store.saveRun(completed);
  return { runId: id, findings, evaluationQuestion: question };
}

/** Records the owner's rating. Earlier ratings stay as history; statistics use the latest one. */
export function rate(ctx: Context, id: string, findingId: string, label: string, note: string, by: string): object {
  const entry = ctx.ledger.read(id);
  if (!entry.findings.some((finding) => finding.id === findingId)) throw new Error(`No finding ${findingId} in run ${id}.`);
  if (!isLabel(label)) throw new Error(`Rating must be one of: ${LABELS.join(", ")}.`);
  entry.evaluations.push({ findingId, label, note, at: now(), by });
  ctx.ledger.write(entry);
  return { runId: id, findingId, label };
}

export function cancel(ctx: Context, key: string): { runId: string; phase: string } {
  const run = ctx.store.active(key);
  if (!run) throw new Error("No run in progress.");
  if (run.phase === "completed") throw new Error("Completed runs are kept.");
  ctx.store.saveRun({ ...base(run), phase: "cancelled" });
  return { runId: run.id, phase: "cancelled" };
}

export function status(ctx: Context, key: string): object | null {
  const run = ctx.store.active(key);
  if (!run) return null;
  return {
    runId: run.id,
    phase: run.phase,
    files: "files" in run ? run.files : [],
    checks: run.checks,
    reviewer: "reviewer" in run ? (run.reviewer ?? null) : null,
    findings: run.phase === "completed" ? run.findings : [],
    evaluationRequest: run.phase === "completed" ? (run.evaluationRequest ?? null) : null,
  };
}

function ensureQuestion(ctx: Context, run: CompletedRun, event: StopInput): HookOutput {
  const request = run.evaluationRequest;
  // Runs from older versions or already asked questions must not block later conversation.
  if (!request || ["asked", "resolved", "missed"].includes(request.status)) return {};
  const text = evaluationQuestion(run, ctx.ledger.read(run.id));
  if (text === null) {
    run.evaluationRequest = { status: "resolved" };
    ctx.store.saveRun(run);
    return {};
  }
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  if (normalize(event.last_assistant_message ?? "").includes(normalize(text))) {
    run.evaluationRequest = { status: "asked", text, at: now() };
    ctx.store.saveRun(run);
    return {};
  }
  if (request.status === "reminded") {
    run.evaluationRequest = { status: "missed", text, at: now() };
    ctx.store.saveRun(run);
    return { systemMessage: "The rating question is still missing. Recorded as missed; no further blocking." };
  }
  run.evaluationRequest = { status: "reminded", text };
  ctx.store.saveRun(run);
  // Remind once, but never loop waiting for the user's answer.
  return {
    decision: "block",
    reason: `Work and review are done but the rating question is missing. Without new checks or edits, keep your report and end the final message with this sentence verbatim, then end the turn without answering it yourself.\n\n${text}`,
  };
}

export function sessionContext(sessionId: string): HookOutput {
  const key = sessionKey(sessionId);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        `rated-review-loop session key: ${key}.`,
        "Do not start a review for questions or documentation.",
        `Before implementing approved code, run \`${BIN} begin ${key} "<task>"\` to record the baseline.`,
        `After implementing, run \`${BIN} ready ${key} <files you implemented>\`; the Stop hook then runs checks and requests a review.`,
        `Check progress with \`${BIN} status ${key}\`. Do not begin twice when resuming. Never rate findings on the user's behalf.`,
      ].join(" "),
    },
  };
}
