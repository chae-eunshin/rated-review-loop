import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENTS, isClient, type Client } from "./types.ts";

export const CONFIG_FILE = "rated-review-loop.config.json";

/** The skill shipped with this package, used when the project does not provide its own. */
export const BUNDLED_SKILL = fileURLToPath(new URL("../skills/review-completed-code/SKILL.md", import.meta.url));

export type ReviewerMode = "session" | `${Client}-cli`;
export type GroupField = "skill" | "reviewer" | "model";

export interface Config {
  /** Review instructions. Their content hash is the skill version used for statistics. */
  skill: string;
  /** Project documents the reviewer compares the change against. */
  guidelines: string[];
  /** Shell commands that must all pass before a review is requested. */
  checks: string[];
  checkTimeoutMs: number;
  /** Globs (relative to the repository root) of files that can be reviewed. */
  include: string[];
  exclude: string[];
  /** `session`: the agent that wrote the code reviews it. `<client>-cli`: a separate CLI process reviews it. */
  reviewer: { mode: ReviewerMode; model?: string };
  /** Language the reviewer writes findings in, e.g. "en" or "ko". */
  language: string;
  stats: {
    groupBy: GroupField[];
    /** Number of most recent decided ratings that make up the health window. */
    window: number;
    /** Alert when the useful rate of a full window is at or below this value. */
    threshold: number;
  };
  ledgerDir: string;
  localDir: string;
}

export const DEFAULT_CONFIG: Config = {
  skill: BUNDLED_SKILL,
  guidelines: [],
  checks: [],
  checkTimeoutMs: 120_000,
  include: ["**/*"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/*.lock", "pnpm-lock.yaml", "package-lock.json"],
  reviewer: { mode: "session" },
  language: "en",
  stats: { groupBy: ["skill", "reviewer"], window: 100, threshold: 0.8 },
  ledgerDir: ".rated-review-loop/ledger",
  localDir: ".rated-review-loop/local",
};

const MODES: readonly ReviewerMode[] = ["session", ...CLIENTS.map((client) => `${client}-cli` as const)];
const GROUP_FIELDS: readonly GroupField[] = ["skill", "reviewer", "model"];

function fail(message: string): never {
  throw new Error(`${CONFIG_FILE}: ${message}`);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    fail(`"${field}" must be an array of strings.`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`"${field}" must be an object.`);
  return value as Record<string, unknown>;
}

/** Validates user config and fills in defaults. Unknown keys are rejected so typos do not pass silently. */
export function parseConfig(raw: unknown): Config {
  const input = record(raw, "(root)");
  const known = new Set<string>(Object.keys(DEFAULT_CONFIG));
  const unknown = Object.keys(input).find((key) => !known.has(key));
  if (unknown !== undefined) fail(`unknown key "${unknown}".`);

  const config: Config = structuredClone(DEFAULT_CONFIG);
  if (input.skill !== undefined) {
    if (typeof input.skill !== "string" || !input.skill) fail(`"skill" must be a path.`);
    config.skill = input.skill;
  }
  if (input.guidelines !== undefined) config.guidelines = stringArray(input.guidelines, "guidelines");
  if (input.checks !== undefined) config.checks = stringArray(input.checks, "checks");
  if (input.include !== undefined) config.include = stringArray(input.include, "include");
  if (input.exclude !== undefined) config.exclude = stringArray(input.exclude, "exclude");
  if (input.checkTimeoutMs !== undefined) {
    if (typeof input.checkTimeoutMs !== "number" || input.checkTimeoutMs <= 0) fail(`"checkTimeoutMs" must be a positive number.`);
    config.checkTimeoutMs = input.checkTimeoutMs;
  }
  if (input.language !== undefined) {
    if (typeof input.language !== "string" || !input.language) fail(`"language" must be a language code.`);
    config.language = input.language;
  }
  if (input.reviewer !== undefined) {
    const reviewer = record(input.reviewer, "reviewer");
    const mode = reviewer.mode;
    if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) {
      fail(`"reviewer.mode" must be one of ${MODES.join(", ")}.`);
    }
    config.reviewer = { mode: mode as ReviewerMode };
    if (reviewer.model !== undefined) {
      if (typeof reviewer.model !== "string" || !reviewer.model) fail(`"reviewer.model" must be a model id.`);
      config.reviewer.model = reviewer.model;
    }
  }
  if (input.stats !== undefined) {
    const stats = record(input.stats, "stats");
    if (stats.groupBy !== undefined) {
      const groupBy = stringArray(stats.groupBy, "stats.groupBy");
      const invalid = groupBy.find((field) => !(GROUP_FIELDS as readonly string[]).includes(field));
      if (invalid !== undefined) fail(`"stats.groupBy" accepts ${GROUP_FIELDS.join(", ")}; got "${invalid}".`);
      config.stats.groupBy = [...new Set(groupBy)] as GroupField[];
    }
    if (stats.window !== undefined) {
      if (!Number.isInteger(stats.window) || (stats.window as number) < 1) fail(`"stats.window" must be a positive integer.`);
      config.stats.window = stats.window as number;
    }
    if (stats.threshold !== undefined) {
      if (typeof stats.threshold !== "number" || stats.threshold < 0 || stats.threshold > 1) {
        fail(`"stats.threshold" must be between 0 and 1.`);
      }
      config.stats.threshold = stats.threshold;
    }
  }
  for (const field of ["ledgerDir", "localDir"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value || isAbsolute(value)) fail(`"${field}" must be a path relative to the repository.`);
    config[field] = value;
  }
  return config;
}

export function loadConfig(root: string): Config {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  return parseConfig(raw);
}

export function skillPath(root: string, config: Config): string {
  return isAbsolute(config.skill) ? config.skill : join(root, config.skill);
}

export function clientOfMode(mode: ReviewerMode): Client | null {
  if (mode === "session") return null;
  const client = mode.slice(0, -"-cli".length);
  return isClient(client) ? client : null;
}
