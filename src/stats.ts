import type { Config, GroupField } from "./config.ts";
import type { Label, LedgerEntry } from "./types.ts";

export interface GroupKey {
  skill?: string;
  reviewer?: string;
  model?: string;
}

export interface GroupStats {
  key: GroupKey;
  runs: number;
  findings: number;
  unrated: number;
  labels: Record<Label, number>;
  /** Health of the most recent decided ratings (deferred ratings are not decisions). */
  window: { size: number; capacity: number; useful: number; usefulRate: number | null };
  alert: boolean;
}

export interface StatsResult {
  window: number;
  threshold: number;
  groups: GroupStats[];
}

function groupKey(entry: LedgerEntry, fields: GroupField[]): GroupKey {
  const key: GroupKey = {};
  for (const field of fields) {
    if (field === "skill") key.skill = entry.skill;
    else if (field === "reviewer") key.reviewer = entry.reviewer.client;
    else key.model = entry.reviewer.model;
  }
  return key;
}

const emptyLabels = (): Record<Label, number> => ({
  useful: 0,
  "out-of-scope": 0,
  unsupported: 0,
  incorrect: 0,
  deferred: 0,
});

/**
 * Groups ledger entries (by skill version and reviewer by default) and checks each group's
 * rolling window. A group alerts only once its window is full, so small samples never alert.
 */
export function computeStats(entries: LedgerEntry[], config: Config): StatsResult {
  const { groupBy, window, threshold } = config.stats;
  const groups = new Map<string, { stats: GroupStats; decided: { at: string; useful: boolean }[] }>();
  for (const entry of entries) {
    const key = groupKey(entry, groupBy);
    const id = JSON.stringify(key);
    let group = groups.get(id);
    if (!group) {
      group = {
        stats: {
          key,
          runs: 0,
          findings: 0,
          unrated: 0,
          labels: emptyLabels(),
          window: { size: 0, capacity: window, useful: 0, usefulRate: null },
          alert: false,
        },
        decided: [],
      };
      groups.set(id, group);
    }
    group.stats.runs += 1;
    group.stats.findings += entry.findings.length;
    for (const finding of entry.findings) {
      const latest = entry.evaluations.findLast((evaluation) => evaluation.findingId === finding.id);
      if (!latest) {
        group.stats.unrated += 1;
        continue;
      }
      group.stats.labels[latest.label] += 1;
      if (latest.label !== "deferred") group.decided.push({ at: latest.at, useful: latest.label === "useful" });
    }
  }
  const result = [...groups.values()].map(({ stats, decided }) => {
    const recent = decided.sort((a, b) => a.at.localeCompare(b.at)).slice(-window);
    const useful = recent.filter((item) => item.useful).length;
    const usefulRate = recent.length ? useful / recent.length : null;
    return {
      ...stats,
      window: { size: recent.length, capacity: window, useful, usefulRate },
      alert: recent.length >= window && usefulRate !== null && usefulRate <= threshold,
    };
  });
  return { window, threshold, groups: result };
}

function describe(key: GroupKey): string {
  return [
    key.skill !== undefined ? `skill ${key.skill}` : null,
    key.reviewer !== undefined ? `reviewer ${key.reviewer}` : null,
    key.model !== undefined ? `model ${key.model}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ") || "all reviews";
}

const percent = (value: number | null): string => (value === null ? "-" : `${Math.round(value * 100)}%`);

export function formatText(stats: StatsResult): string {
  if (!stats.groups.length) return "No completed reviews in the ledger yet.";
  return stats.groups
    .map((group) => {
      const { size, capacity, usefulRate } = group.window;
      const health =
        size < capacity
          ? `useful ${percent(usefulRate)} over ${size}/${capacity} (not enough ratings to alert)`
          : `useful ${percent(usefulRate)} over the last ${capacity}${group.alert ? `  ⚠ at or below ${percent(stats.threshold)}` : ""}`;
      return `${describe(group.key)}: ${group.runs} runs, ${group.findings} findings, ${group.unrated} unrated — ${health}`;
    })
    .join("\n");
}

/** Comment body for a pull request. Empty when no group alerts, so callers comment only on degradation. */
export function formatMarkdown(stats: StatsResult): string {
  const alerts = stats.groups.filter((group) => group.alert);
  if (!alerts.length) return "";
  const rows = alerts.map(
    (group) =>
      `| ${describe(group.key)} | ${percent(group.window.usefulRate)} | ${group.window.useful}/${group.window.size} | ${group.labels.incorrect} | ${group.labels.unsupported} |`,
  );
  return [
    "### ⚠ Review usefulness dropped",
    "",
    `The last ${stats.window} decided ratings of these reviewers are at or below ${percent(stats.threshold)} useful.`,
    "",
    "| Group | Useful | Useful / rated | Incorrect (all time) | Unsupported (all time) |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Consider revising the review skill or switching the reviewer, then compare the new version's window.",
  ].join("\n");
}
