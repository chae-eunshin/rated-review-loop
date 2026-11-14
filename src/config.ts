import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { CLIENTS, isClient, type Client } from "./types.ts";

export const CONFIG_FILE = "rated-review-loop.config.json";

/** The skill shipped with this package, used when the project does not provide its own. */
export const BUNDLED_SKILL = fileURLToPath(new URL("../skills/review-completed-code/SKILL.md", import.meta.url));

const MODES = ["session", ...CLIENTS.map((client) => `${client}-cli` as const)] as const;
const GROUP_FIELDS = ["skill", "reviewer", "model"] as const;

export type ReviewerMode = (typeof MODES)[number];
export type GroupField = (typeof GROUP_FIELDS)[number];

/** `min(1)` and `max` appear in the JSON Schema; the refinement also rejects whitespace-only values. */
const nonEmpty = z
  .string()
  .min(1, { error: "must not be empty" })
  .refine((value) => value.trim() !== "", "must not be empty");
const sentence = (max: number) =>
  z
    .string()
    .min(1, { error: "must not be empty" })
    .max(max, { error: `must be at most ${max} characters` })
    .refine((value) => value.trim() !== "", "must not be empty");
const relativePath = z
  .string()
  .refine((value) => value !== "" && !isAbsolute(value), "must be a path relative to the repository root");
const strings = (description: string) =>
  z.array(nonEmpty, { error: "must be an array of strings" }).describe(description);

const GuidelineInputSchema = z.union([
  relativePath.describe("A document the reviewer always reads, relative to the repository root."),
  z.strictObject({
    path: relativePath.describe("Document path, relative to the repository root. Must exist."),
    when: sentence(200).describe(
      'When the reviewer should read it, stated in terms of the change, e.g. "an import crosses a src/features/* boundary". One sentence.',
    ),
    covers: sentence(200).optional().describe("The rules this document holds, so a finding can cite it as its rule."),
  }),
]);

/**
 * The shape of `rated-review-loop.config.json`. The file is user input, so it is parsed with this schema; the same
 * schema generates the JSON Schema that editors and agents use to complete and check the file.
 */
export const ConfigInputSchema = z
  .strictObject({
    $schema: z.string().optional().describe("JSON Schema for editor completion."),
    skill: nonEmpty
      .optional()
      .describe("Review instructions. Defaults to the skill bundled with the package. Part of the version hash."),
    guidelines: z
      .array(GuidelineInputSchema)
      .optional()
      .describe("Project documents the reviewer compares the change against: always, or only when a condition applies."),
    instructions: z
      .strictObject({
        session: sentence(2000).optional().describe("Project rules for the coding agent, added to the SessionStart context."),
        review: sentence(2000)
          .optional()
          .describe("Extra instructions for the reviewer, session or CLI. Part of the version hash."),
        afterReview: sentence(2000)
          .optional()
          .describe("What the coding agent does after the review is recorded, e.g. update a document."),
      })
      .optional()
      .describe("Project text added to what the coding agent and the reviewer are told."),
    gates: z
      .strictObject({
        begin: strings(
          "Shell commands that must pass before begin records a baseline. They get RATED_REVIEW_LOOP_INPUT (from begin --input), RATED_REVIEW_LOOP_TASK and RATED_REVIEW_LOOP_SESSION_KEY.",
        ).optional(),
      })
      .optional()
      .describe("Steps that must pass before work starts, like checks before a review."),
    checks: strings("Shell commands that must all pass before a review is requested.").optional(),
    checkTimeoutMs: z
      .number()
      .positive({ error: "must be a positive number" })
      .optional()
      .describe("Timeout of each check and gate, in milliseconds."),
    include: strings("Globs, relative to the repository root, of files that can be reviewed.").optional(),
    exclude: strings("Globs excluded from review. Replaces the default list.").optional(),
    reviewer: z
      .strictObject({
        mode: z.enum(MODES, { error: `must be one of ${MODES.join(", ")}` }),
        model: nonEmpty.optional().describe("Model for a CLI reviewer."),
      })
      .optional()
      .describe("session: the agent that wrote the code reviews it. <client>-cli: a separate CLI process does."),
    language: nonEmpty.optional().describe('Language the reviewer writes findings in, e.g. "en" or "ko".'),
    stats: z
      .strictObject({
        groupBy: z.array(z.enum(GROUP_FIELDS, { error: `accepts ${GROUP_FIELDS.join(", ")}` })).optional(),
        window: z.int({ error: "must be a positive integer" }).min(1, { error: "must be a positive integer" }).optional(),
        threshold: z
          .number()
          .min(0, { error: "must be between 0 and 1" })
          .max(1, { error: "must be between 0 and 1" })
          .optional(),
      })
      .optional(),
    ledgerDir: relativePath.optional().describe("Committed ratings."),
    localDir: relativePath.optional().describe("Local run state. Must be ignored by git."),
  })
  .superRefine((input, context) => {
    const seen = new Set<string>();
    input.guidelines?.forEach((item, index) => {
      const path = typeof item === "string" ? item : item.path;
      if (seen.has(path)) context.addIssue({ code: "custom", path: ["guidelines", index], message: `lists "${path}" twice` });
      seen.add(path);
    });
  });

/** JSON Schema of the config file, published as `config.schema.json`. */
export const CONFIG_JSON_SCHEMA = z.toJSONSchema(ConfigInputSchema, { target: "draft-07", io: "input" });

/** A guideline with the optional parts made explicit: `when === null` means it is always read. */
export interface Guideline {
  path: string;
  when: string | null;
  covers: string | null;
}

export interface Config {
  /** Review instructions. With `guidelines` and `instructions.review`, their hash is the version used for statistics. */
  skill: string;
  guidelines: Guideline[];
  instructions: { session: string | null; review: string | null; afterReview: string | null };
  gates: { begin: string[] };
  checks: string[];
  checkTimeoutMs: number;
  include: string[];
  exclude: string[];
  reviewer: { mode: ReviewerMode; model?: string };
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
  instructions: { session: null, review: null, afterReview: null },
  gates: { begin: [] },
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

function fail(message: string): never {
  throw new Error(`${CONFIG_FILE}: ${message}`);
}

/** The most specific problem: inside a union, the branch that matched the value's type. */
function describeProblem(issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): string {
  const issue = issues[0];
  if (!issue) return "invalid value.";
  const path = [...prefix, ...issue.path].map(String);
  if (issue.code === "invalid_union") {
    // The branch that got furthest into the value is the one the user meant (an object, not a string).
    const branch =
      issue.errors.find((candidate) => (candidate[0]?.path.length ?? 0) > 0 || candidate[0]?.code !== "invalid_type") ??
      issue.errors[0] ??
      [];
    return describeProblem(branch, path);
  }
  if (issue.code === "unrecognized_keys") {
    return `unknown key "${issue.keys[0] ?? ""}"${path.length ? ` in "${path.join(".")}"` : ""}.`;
  }
  const message = issue.code === "invalid_type" && issue.message.endsWith("received undefined") ? "is required" : issue.message;
  return `"${path.join(".") || "(root)"}" ${message}.`;
}

function toGuideline(input: z.infer<typeof GuidelineInputSchema>): Guideline {
  return typeof input === "string"
    ? { path: input, when: null, covers: null }
    : { path: input.path, when: input.when, covers: input.covers ?? null };
}

/** Validates user config and fills in defaults. Unknown keys are rejected so typos do not pass silently. */
export function parseConfig(raw: unknown): Config {
  const result = ConfigInputSchema.safeParse(raw);
  if (!result.success) fail(describeProblem(result.error.issues));
  const input = result.data;
  const defaults = structuredClone(DEFAULT_CONFIG);
  return {
    skill: input.skill ?? defaults.skill,
    guidelines: (input.guidelines ?? []).map(toGuideline),
    instructions: {
      session: input.instructions?.session ?? null,
      review: input.instructions?.review ?? null,
      afterReview: input.instructions?.afterReview ?? null,
    },
    gates: { begin: input.gates?.begin ?? [] },
    checks: input.checks ?? defaults.checks,
    checkTimeoutMs: input.checkTimeoutMs ?? defaults.checkTimeoutMs,
    include: input.include ?? defaults.include,
    exclude: input.exclude ?? defaults.exclude,
    reviewer: input.reviewer
      ? { mode: input.reviewer.mode, ...(input.reviewer.model !== undefined ? { model: input.reviewer.model } : {}) }
      : defaults.reviewer,
    language: input.language ?? defaults.language,
    stats: {
      groupBy: input.stats?.groupBy ? [...new Set(input.stats.groupBy)] : defaults.stats.groupBy,
      window: input.stats?.window ?? defaults.stats.window,
      threshold: input.stats?.threshold ?? defaults.stats.threshold,
    },
    ledgerDir: input.ledgerDir ?? defaults.ledgerDir,
    localDir: input.localDir ?? defaults.localDir,
  };
}

/** Reads the config file, if any. Checks what the schema cannot: that every guideline exists in this repository. */
export function loadConfig(root: string): Config {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  const config = parseConfig(raw);
  const missing = config.guidelines.find((item) => !existsSync(join(root, item.path)));
  if (missing) fail(`guideline "${missing.path}" does not exist.`);
  return config;
}

/** How the reviewer is told about the guidelines, in the session request and the CLI prompt alike. */
export function describeGuidelines(guidelines: Guideline[]): string | null {
  if (!guidelines.length) return null;
  const always = guidelines.filter((item) => item.when === null).map((item) => item.path);
  const conditional = guidelines
    .filter((item) => item.when !== null)
    .map((item) => `${item.path} (when ${item.when ?? ""}${item.covers ? `; covers ${item.covers}` : ""})`);
  return [
    "Project guidelines.",
    always.length ? `Always read: ${always.join(", ")}.` : "",
    conditional.length ? `Read only when it applies to the change: ${conditional.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function skillPath(root: string, config: Config): string {
  return isAbsolute(config.skill) ? config.skill : join(root, config.skill);
}

/** Where the installed package exposes the bundled skill, through the `node_modules` link package managers create. */
const LINKED_SKILL = join("node_modules", "rated-review-loop", "skills", "review-completed-code", "SKILL.md");

/**
 * The skill path to show an agent: relative to the repository when possible. pnpm resolves the bundled skill into
 * its store (`node_modules/.pnpm/<long name>/...`), so the `node_modules/rated-review-loop` link is preferred.
 */
export function skillDisplayPath(root: string, config: Config): string {
  const actual = skillPath(root, config);
  const linked = join(root, LINKED_SKILL);
  if (existsSync(linked) && realpathSync(linked) === realpathSync(actual)) return LINKED_SKILL;
  const inside = relative(root, actual);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : actual;
}

export function clientOfMode(mode: ReviewerMode): Client | null {
  if (mode === "session") return null;
  const client = mode.slice(0, -"-cli".length);
  return isClient(client) ? client : null;
}
