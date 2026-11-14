import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA_FILE, configSchemaText } from "../scripts/generate-config-schema.ts";
import { CONFIG_FILE, DEFAULT_CONFIG, describeGuidelines, loadConfig, parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
  it("fills defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("accepts a full config", () => {
    const config = parseConfig({
      skill: ".agents/skills/review/SKILL.md",
      guidelines: ["AGENTS.md"],
      checks: ["pnpm typecheck", "pnpm lint"],
      reviewer: { mode: "codex-cli", model: "some-model" },
      language: "ko",
      stats: { groupBy: ["skill", "reviewer", "model"], window: 50, threshold: 0.7 },
    });
    expect(config.reviewer).toEqual({ mode: "codex-cli", model: "some-model" });
    expect(config.stats).toEqual({ groupBy: ["skill", "reviewer", "model"], window: 50, threshold: 0.7 });
  });

  it.each([
    [{ chekcs: [] }, /unknown key "chekcs"/],
    [{ checks: "pnpm lint" }, /"checks" must be an array/],
    [{ reviewer: { mode: "gemini-cli" } }, /reviewer.mode/],
    [{ stats: { groupBy: ["author"] } }, /stats.groupBy/],
    [{ stats: { threshold: 80 } }, /between 0 and 1/],
    [{ stats: { window: 0 } }, /positive integer/],
    [{ ledgerDir: "/tmp/ledger" }, /relative/],
  ])("rejects %j", (input, message) => {
    expect(() => parseConfig(input)).toThrow(message);
  });
});

describe("guidelines, instructions and gates", () => {
  it("normalizes always-read and conditional guidelines", () => {
    const config = parseConfig({
      guidelines: [
        "AGENTS.md",
        { path: "docs/deps.md", when: "an import crosses a feature boundary", covers: "dependency directions" },
        { path: "docs/naming.md", when: "a name is added or renamed" },
      ],
    });
    expect(config.guidelines).toEqual([
      { path: "AGENTS.md", when: null, covers: null },
      { path: "docs/deps.md", when: "an import crosses a feature boundary", covers: "dependency directions" },
      { path: "docs/naming.md", when: "a name is added or renamed", covers: null },
    ]);
  });

  it("accepts instructions, gates and a $schema reference", () => {
    const config = parseConfig({
      $schema: "./node_modules/rated-review-loop/config.schema.json",
      instructions: { session: "s", review: "r", afterReview: "a" },
      gates: { begin: ["test -n \"$RATED_REVIEW_LOOP_INPUT\""] },
    });
    expect(config.instructions).toEqual({ session: "s", review: "r", afterReview: "a" });
    expect(config.gates.begin).toHaveLength(1);
  });

  it.each([
    [{ guidelines: [{ path: "a.md" }] }, /"guidelines.0.when" is required/],
    [{ guidelines: [{ path: "a.md", when: "x".repeat(201) }] }, /"guidelines.0.when" must be at most 200/],
    [{ guidelines: [{ path: "a.md", when: "   " }] }, /"guidelines.0.when" must not be empty/],
    [{ guidelines: [{ path: "a.md", when: "x", note: "y" }] }, /unknown key "note" in "guidelines.0"/],
    [{ guidelines: ["/abs/a.md"] }, /"guidelines.0" must be a path relative/],
    [{ guidelines: ["a.md", { path: "a.md", when: "x" }] }, /"guidelines.1" lists "a.md" twice/],
    [{ instructions: { reviw: "x" } }, /unknown key "reviw" in "instructions"/],
    [{ gates: { begin: "pnpm check" } }, /"gates.begin" must be an array of strings/],
  ])("rejects %j with a specific message", (input, message) => {
    expect(() => parseConfig(input)).toThrow(message);
  });

  it("refuses a guideline that does not exist in the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "rated-review-loop-config-"));
    try {
      writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ guidelines: ["missing.md"] }));
      expect(() => loadConfig(root)).toThrow(/guideline "missing.md" does not exist/);
      writeFileSync(join(root, "missing.md"), "# now it exists\n");
      expect(loadConfig(root).guidelines).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("describes guidelines the same way to every reviewer", () => {
    expect(describeGuidelines([])).toBeNull();
    expect(
      describeGuidelines(
        parseConfig({ guidelines: ["AGENTS.md", { path: "docs/deps.md", when: "an import crosses a boundary", covers: "directions" }] })
          .guidelines,
      ),
    ).toBe(
      "Project guidelines. Always read: AGENTS.md. Read only when it applies to the change: docs/deps.md (when an import crosses a boundary; covers directions).",
    );
  });
});

describe("config.schema.json", () => {
  it("is generated from the schema the CLI validates with", () => {
    expect(readFileSync(CONFIG_SCHEMA_FILE, "utf8")).toBe(configSchemaText());
  });
});
