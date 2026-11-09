/**
 * Keeps the English and Korean READMEs in step.
 * Prose may differ between languages, but the outline (heading levels in order) and every code block must match,
 * so a section or example added to only one of them is caught.
 */

export const README_PAIR = ["README.md", "README-ko_kr.md"] as const;
export const ONE_SIDED_MARKER = "README one-sided:";

export interface Outline {
  headings: number[];
  codeBlocks: string[];
}

export function outline(markdown: string): Outline {
  const headings: number[] = [];
  const codeBlocks: string[] = [];
  let fence: { marker: string; lines: string[]; info: string } | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^(```+|~~~+)(.*)$/.exec(line.trim());
    if (fence) {
      if (fenceMatch?.[1] !== undefined && fenceMatch[1].startsWith(fence.marker) && !fenceMatch[2]?.trim()) {
        codeBlocks.push(`${fence.info}\n${fence.lines.join("\n")}`);
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch?.[1] !== undefined) {
      fence = { marker: fenceMatch[1], lines: [], info: (fenceMatch[2] ?? "").trim() };
      continue;
    }
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading?.[1] !== undefined) headings.push(heading[1].length);
  }
  return { headings, codeBlocks };
}

/** Differences between the two outlines, as human-readable problems. */
export function compareOutlines(english: Outline, korean: Outline): string[] {
  const problems: string[] = [];
  if (english.headings.join(",") !== korean.headings.join(",")) {
    problems.push(
      `Heading structure differs: README.md [${english.headings.join(",")}] vs README-ko_kr.md [${korean.headings.join(",")}].`,
    );
  }
  if (english.codeBlocks.length !== korean.codeBlocks.length) {
    problems.push(`Code block count differs: ${english.codeBlocks.length} vs ${korean.codeBlocks.length}.`);
  } else {
    english.codeBlocks.forEach((block, index) => {
      if (block !== korean.codeBlocks[index]) problems.push(`Code block ${index + 1} differs between the READMEs.`);
    });
  }
  return problems;
}

/** A change to only one README needs a reason in the pull request description. */
export function checkChangedPair(changedFiles: string[], prBody: string): string[] {
  const touched = README_PAIR.filter((file) => changedFiles.includes(file));
  if (touched.length !== 1) return [];
  const reason = prBody
    .split("\n")
    .find((line) => line.trim().startsWith(ONE_SIDED_MARKER))
    ?.trim()
    .slice(ONE_SIDED_MARKER.length)
    .trim();
  if (reason) return [];
  const other = README_PAIR.find((file) => file !== touched[0]);
  return [
    `Only ${String(touched[0])} changed. Update ${String(other)} too, or explain why in the PR description with a line "${ONE_SIDED_MARKER} <reason>".`,
  ];
}
