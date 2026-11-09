
import { readFileSync } from "node:fs";

import { skillPath, type Config } from "../config.ts";
import type { Client, Reviewer } from "../types.ts";

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Process launcher, injectable so adapters can be tested without the real CLIs. */
export type Spawn = (command: string, args: string[], options: { cwd: string; input: string; timeoutMs: number }) => SpawnResult;


export interface ReviewRequest {
  root: string;
  /** JSON file holding the change under review, inside the repository so the CLI may read it. */
  packetPath: string;
  /** Scratch directory the adapter may write to (schema, output files). */
  workDir: string;
  prompt: string;
  model?: string;
}

export interface ReviewResult {
  report: unknown;
  reviewer: Reviewer;
}

/** Contract every CLI reviewer fulfils: same input, same report shape, whoever does the reviewing. */
export interface CliReviewer {
  client: Client;
  review(request: ReviewRequest, spawn: Spawn): ReviewResult;
}


export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "title", "rule", "impact", "suggestion"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          title: { type: "string" },
          rule: { type: "string" },
          impact: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
} as const;

export function reviewPrompt(root: string, config: Config, packetPath: string): string {
  const guidelines = config.guidelines.length
    ? `Project guidelines to compare against (read the relevant ones): ${config.guidelines.join(", ")}.`
    : "The project has no extra guidelines configured.";
  return [
    readFileSync(skillPath(root, config), "utf8"),
    "---",
    "You are running as an independent reviewer outside the coding session.",
    `The change to review is in ${packetPath} (JSON: changes[].path/before/after). You may read other repository files for context.`,
    guidelines,
    `Write summary and findings in language "${config.language}".`,
    "Do not modify any file. Respond only with the JSON object described by the output schema.",
  ].join("\n\n");
}

export function failure(client: Client, result: SpawnResult): Error {
  const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim()).slice(-2_000);
  return new Error(`${client} reviewer failed (exit ${String(result.status)}): ${detail}`);
}

