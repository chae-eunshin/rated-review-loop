#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { loadConfig } from "./config.ts";
import {
  begin,
  cancel,
  createContext,
  handleStop,
  packet,
  prune,
  rate,
  ready,
  sessionContext,
  status,
  submit,
  type Context,
  type HookOutput,
} from "./cycle.ts";
import { reviewWithCli } from "./review.ts";
import { describeIssue, HookEventSchema } from "./schemas.ts";
import { computeStats, formatMarkdown, formatText } from "./stats.ts";
import { isClient, type Client } from "./types.ts";

const USAGE = `Usage: rated-review-loop <command>

  hook --client <claude|codex>          Handle a SessionStart/Stop hook event from stdin
  begin <session-key> <task>            Record the baseline before implementing
  ready <session-key> <file...>         Mark the files you implemented as ready for checks
  packet <run-id>                       Print the change under review
  submit <run-id> <report.json>         Record a review report written by the session agent
  review <run-id>                       Have the configured CLI reviewer review and record the run
  rate <run-id> <F#> <label> [note]     Record the owner's rating of a finding
  status <session-key>                  Show the run bound to a session
  cancel <session-key>                  Cancel the run bound to a session
  stats [--format json|text|markdown]   Usefulness per skill version and reviewer
  prune [--days <n>]                    Delete local runs finished more than n days ago (default 14)`;

function gitRoot(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`Missing <${name}>.\n\n${USAGE}`);
  return value;
}

function gitUser(root: string): string {
  try {
    return execFileSync("git", ["config", "user.name"], { cwd: root, encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function runHook(args: string[]): HookOutput {
  const client = option(args, "--client");
  if (client === undefined || !isClient(client)) throw new Error("hook needs --client claude or --client codex.");
  const raw: unknown = JSON.parse(readFileSync(0, "utf8"));
  // Other events may be routed here by a broad hook config; they are not ours to validate.
  const name = typeof raw === "object" && raw !== null && "hook_event_name" in raw ? raw.hook_event_name : undefined;
  if (name !== "SessionStart" && name !== "Stop") return {};
  const parsed = HookEventSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`unexpected ${name} hook input (${describeIssue(parsed.error)})`);
  const event = parsed.data;
  if (event.hook_event_name === "SessionStart") return sessionContext(event.session_id);
  const root = gitRoot(event.cwd ?? process.cwd());
  return handleStop(createContext(root, loadConfig(root)), event, client satisfies Client);
}

function runCommand(command: string | undefined, args: string[]): unknown {
  const root = gitRoot(process.cwd());
  const ctx: Context = createContext(root, loadConfig(root));
  switch (command) {
    case "begin":
      return begin(ctx, required(args[0], "session-key"), required(args[1], "task"));
    case "ready":
      return ready(ctx, required(args[0], "session-key"), args.slice(1));
    case "packet":
      return packet(ctx, required(args[0], "run-id"));
    case "submit":
      return submit(ctx, required(args[0], "run-id"), JSON.parse(readFileSync(required(args[1], "report.json"), "utf8")));
    case "review":
      return reviewWithCli(ctx, required(args[0], "run-id"));
    case "rate":
      return rate(ctx, required(args[0], "run-id"), required(args[1], "F#"), required(args[2], "label"), args[3] ?? "", gitUser(root));
    case "status":
      return status(ctx, required(args[0], "session-key"));
    case "cancel":
      return cancel(ctx, required(args[0], "session-key"));
    case "prune": {
      const days = option(args, "--days");
      return days === undefined ? prune(ctx) : prune(ctx, Number(days));
    }
    case "stats": {
      const stats = computeStats(ctx.ledger.all(), ctx.config);
      const format = option(args, "--format") ?? "json";
      if (format === "text") return formatText(stats);
      if (format === "markdown") return formatMarkdown(stats);
      if (format === "json") return stats;
      throw new Error("--format must be json, text or markdown.");
    }
    default:
      throw new Error(USAGE);
  }
}

const [command, ...args] = process.argv.slice(2);
const isHook = command === "hook";
try {
  const result = isHook ? runHook(args) : runCommand(command, args);
  process.stdout.write(typeof result === "string" ? (result ? `${result}\n` : "") : `${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (isHook) {
    // A broken hook must not block the user's conversation over and over; report it once and let the turn end.
    process.stdout.write(`${JSON.stringify({ systemMessage: `rated-review-loop hook failed: ${message}. This does not mean the review ran.` })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
