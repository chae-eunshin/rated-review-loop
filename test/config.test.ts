import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";

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
