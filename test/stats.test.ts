import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.ts";
import { computeStats, formatMarkdown } from "../src/stats.ts";
import { ledgerEntry } from "./helpers.ts";

const repeat = (label: string, count: number): string[] => Array.from({ length: count }, () => label);
const config = (stats: Record<string, unknown> = {}) => parseConfig({ stats: { window: 10, threshold: 0.8, ...stats } });

describe("computeStats", () => {
  it("does not alert before the window is full", () => {
    const stats = computeStats([ledgerEntry(repeat("incorrect", 9))], config());
    expect(stats.groups[0]?.window.size).toBe(9);
    expect(stats.groups[0]?.alert).toBe(false);
  });

  it("alerts when the full window is at or below the threshold", () => {
    const entries = [ledgerEntry([...repeat("useful", 8), ...repeat("incorrect", 2)])];
    expect(computeStats(entries, config()).groups[0]?.alert).toBe(true);
    expect(computeStats(entries, config({ threshold: 0.79 })).groups[0]?.alert).toBe(false);
  });

  it("looks only at the most recent ratings", () => {
    const entries = [ledgerEntry(repeat("incorrect", 10)), ledgerEntry(repeat("useful", 10))];
    const group = computeStats(entries, config()).groups[0];
    expect(group?.window.usefulRate).toBe(1);
    expect(group?.alert).toBe(false);
  });

  it("does not count deferred or unrated findings as decisions", () => {
    const group = computeStats([ledgerEntry(["useful", "deferred", "unrated", "incorrect"])], config()).groups[0];
    expect(group?.window.size).toBe(2);
    expect(group?.unrated).toBe(1);
    expect(group?.labels.deferred).toBe(1);
  });

  it("uses the latest rating of a finding", () => {
    const entry = ledgerEntry(["incorrect"]);
    entry.evaluations.push({ findingId: "F1", label: "useful", note: "", at: "2999-01-01T00:00:00.000Z", by: "o" });
    expect(computeStats([entry], config()).groups[0]?.labels).toMatchObject({ useful: 1, incorrect: 0 });
  });

  it("groups by skill and reviewer by default, and by model when configured", () => {
    const entries = [
      ledgerEntry(["useful"], { skill: "a", client: "claude", model: "m1" }),
      ledgerEntry(["useful"], { skill: "a", client: "claude", model: "m2" }),
      ledgerEntry(["useful"], { skill: "a", client: "codex", model: "m1" }),
      ledgerEntry(["useful"], { skill: "b", client: "claude", model: "m1" }),
    ];
    expect(computeStats(entries, config()).groups.map((group) => group.key)).toEqual([
      { skill: "a", reviewer: "claude" },
      { skill: "a", reviewer: "codex" },
      { skill: "b", reviewer: "claude" },
    ]);
    expect(computeStats(entries, config({ groupBy: ["skill", "reviewer", "model"] })).groups).toHaveLength(4);
  });
});

describe("formatMarkdown", () => {
  it("is empty when nothing alerts, so CI comments only on degradation", () => {
    expect(formatMarkdown(computeStats([ledgerEntry(repeat("useful", 10))], config()))).toBe("");
  });

  it("lists the alerting groups", () => {
    const markdown = formatMarkdown(computeStats([ledgerEntry(repeat("incorrect", 10))], config()));
    expect(markdown).toContain("Review usefulness dropped");
    expect(markdown).toContain("skill skill-a · reviewer claude");
  });
});
