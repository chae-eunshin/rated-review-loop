import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import picomatch from "picomatch";

import { skillPath, type Config } from "./config.ts";
import type { LedgerEntry, Run } from "./types.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sessionKey(sessionId: string): string {
  if (!sessionId) throw new Error("session_id is required.");
  return hash(sessionId).slice(0, 16);
}

export function assertKey(key: string): void {
  if (!/^[a-f0-9]{16}$/.test(key)) throw new Error("A 16-character session key is required.");
}

export function assertRunId(id: string): void {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("A run id is required.");
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, path);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Skill version: content hash only, so tool upgrades do not reset statistics and reverting the skill resumes them. */
export function skillVersion(root: string, config: Config): string {
  return hash(readFileSync(skillPath(root, config), "utf8")).slice(0, 12);
}

/** Files git knows about (tracked or untracked but not ignored) that match the review scope. */
export function snapshot(root: string, config: Config): Record<string, string> {
  const include = picomatch(config.include, { dot: true });
  const exclude = picomatch(
    [...config.exclude, ".git/**", ".rated-review-loop/**", `${config.ledgerDir}/**`, `${config.localDir}/**`],
    { dot: true },
  );
  const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const result: Record<string, string> = {};
  for (const path of [...new Set(names.split("\0").filter(Boolean))].sort()) {
    if (!include(path) || exclude(path)) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (!stat.isFile()) continue;
    // Large and binary files (images, fonts, archives) are not reviewable source.
    if (stat.size > MAX_FILE_BYTES) continue;
    const content = readFileSync(absolute);
    if (content.subarray(0, 8000).includes(0)) continue;
    result[path] = content.toString("utf8");
  }
  return result;
}

export function fingerprint(files: Record<string, string>): string {
  return hash(JSON.stringify(files));
}

/** Local state lives under `localDir` and holds source snapshots; it must stay out of git. */
export class LocalStore {
  private readonly base: string;

  constructor(root: string, config: Config) {
    this.base = join(root, config.localDir);
  }

  runPath(id: string): string {
    assertRunId(id);
    return join(this.base, "runs", `${id}.json`);
  }

  sessionPath(key: string): string {
    assertKey(key);
    return join(this.base, "sessions", `${key}.json`);
  }

  lockPath(id: string): string {
    assertRunId(id);
    return join(this.base, "locks", id);
  }

  workPath(id: string, name: string): string {
    assertRunId(id);
    return join(this.base, "work", id, name);
  }

  readRun(id: string): Run {
    const path = this.runPath(id);
    if (!existsSync(path)) throw new Error(`No run ${id}.`);
    return readJson(path) as Run;
  }

  saveRun(run: Run): void {
    writeJsonAtomic(this.runPath(run.id), run);
  }

  /** The run bound to a session, if any. */
  active(key: string): Run | null {
    const path = this.sessionPath(key);
    if (!existsSync(path)) return null;
    const { runId } = readJson(path) as { runId: string };
    return this.readRun(runId);
  }

  bind(key: string, runId: string): void {
    writeJsonAtomic(this.sessionPath(key), { runId });
  }
}

/** The ledger is committed and shared by the team: one file per run, so teammates rarely conflict. */
export class Ledger {
  private readonly base: string;

  constructor(root: string, config: Config) {
    this.base = join(root, config.ledgerDir);
  }

  path(runId: string): string {
    assertRunId(runId);
    return join(this.base, `${runId}.json`);
  }

  read(runId: string): LedgerEntry {
    const path = this.path(runId);
    if (!existsSync(path)) throw new Error(`No ledger entry for run ${runId}.`);
    return readJson(path) as LedgerEntry;
  }

  write(entry: LedgerEntry): void {
    writeJsonAtomic(this.path(entry.runId), entry, 0o644);
  }

  all(): LedgerEntry[] {
    if (!existsSync(this.base)) return [];
    return readdirSync(this.base)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readJson(join(this.base, name)) as LedgerEntry);
  }
}
