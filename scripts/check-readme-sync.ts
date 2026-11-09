// Usage: node scripts/check-readme-sync.ts [--base <git ref>]
// With --base (in CI), also checks which README files the pull request changed; PR_BODY holds its description.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { checkChangedPair, compareOutlines, outline, README_PAIR } from "./readme-sync.ts";

const [english, korean] = README_PAIR.map((file) => outline(readFileSync(file, "utf8")));
const problems = english && korean ? compareOutlines(english, korean) : ["README files are missing."];

const baseIndex = process.argv.indexOf("--base");
const base = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];
if (base !== undefined) {
  const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
  problems.push(...checkChangedPair(changed, process.env.PR_BODY ?? ""));
}

if (problems.length) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exitCode = 1;
} else {
  console.log("✓ READMEs are in sync.");
}
