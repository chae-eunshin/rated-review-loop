import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import picomatch from "picomatch";

import { skillPath, type Config } from "./config.ts";
import { FINISHED_PHASES, RUN_SCHEMA_VERSION, type LedgerEntry, type Run } from "./types.ts";

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

/**
 * Path → content id of every regular file in the review scope. Ids are git blob ids, so unchanged tracked files are
 * never read: their id comes from the index, and only files `git status` reports as dirty or untracked are hashed.
 * Files over the size limit get a size/mtime id instead of being hashed; they are never reviewable anyway.
 */
export type Snapshot = Record<string, string>;

const LARGE_ID = "large:";
const HASH_BATCH = 200;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function scopeMatcher(config: Config): (path: string) => boolean {
  const include = picomatch(config.include, { dot: true });
  const exclude = picomatch(
    [...config.exclude, ".git/**", ".rated-review-loop/**", `${config.ledgerDir}/**`, `${config.localDir}/**`],
    { dot: true },
  );
  return (path) => include(path) && !exclude(path);
}

/** The text after the n-th space of a `git status --porcelain=v2` record, which is where its path starts. */
function afterSpaces(record: string, count: number): string {
  let index = -1;
  for (let seen = 0; seen < count; seen += 1) index = record.indexOf(" ", index + 1);
  return record.slice(index + 1);
}

/** Paths whose working tree content may differ from the index: modified, added, deleted, unmerged, untracked. */
function dirtyPaths(root: string): string[] {
  const records = git(root, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    "--ignore-submodules=all",
  ]).split("\0");
  const paths: string[] = [];
  for (const record of records) {
    if (record.startsWith("1 ")) paths.push(afterSpaces(record, 8));
    else if (record.startsWith("u ")) paths.push(afterSpaces(record, 10));
    else if (record.startsWith("? ")) paths.push(record.slice(2));
  }
  return paths;
}

/** Git blob ids of working tree files, with the same clean filters (line endings, attributes) the index uses. */
function hashFiles(root: string, paths: string[]): string[] {
  const ids: string[] = [];
  for (let start = 0; start < paths.length; start += HASH_BATCH) {
    const batch = paths.slice(start, start + HASH_BATCH);
    ids.push(...git(root, ["hash-object", "--", ...batch]).trim().split("\n"));
  }
  return ids;
}

interface Scan {
  files: Snapshot;
  /** Paths whose id was computed from the working tree, so their content may exist nowhere in git. */
  hashed: string[];
}

function scan(root: string, config: Config): Scan {
  const inScope = scopeMatcher(config);
  const files = new Map<string, string>();
  for (const record of git(root, ["ls-files", "-s", "-z"]).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, id] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    // Regular files only: symlinks (120000) and submodules (160000) are not reviewable source.
    if ((mode === "100644" || mode === "100755") && id !== undefined && inScope(path)) files.set(path, id);
  }
  const hashed: string[] = [];
  for (const path of [...new Set(dirtyPaths(root))]) {
    if (!inScope(path)) continue;
    files.delete(path);
    let stat;
    try {
      stat = lstatSync(join(root, path));
    } catch {
      continue; // Deleted in the working tree.
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) files.set(path, `${LARGE_ID}${stat.size}:${stat.mtimeMs}`);
    else hashed.push(path);
  }
  hashFiles(root, hashed).forEach((id, index) => {
    files.set(hashed[index] as string, id);
  });
  return { files: Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), hashed };
}

export function snapshot(root: string, config: Config): Snapshot {
  return scan(root, config).files;
}

/**
 * The snapshot taken at `begin`. Content that git already holds can be read back later; files that were dirty or
 * untracked are copied into the local object store, because that state exists nowhere else.
 */
export function captureBaseline(root: string, config: Config, store: LocalStore): Snapshot {
  const { files, hashed } = scan(root, config);
  for (const path of hashed) {
    const id = files[path];
    if (id !== undefined) store.saveObject(id, readFileSync(join(root, path)));
  }
  return files;
}

export function fingerprint(files: Snapshot): string {
  return hash(JSON.stringify(files));
}

/** Large and binary files (images, fonts, archives) are not reviewable source. */
function isReviewable(content: Buffer): boolean {
  return content.length <= MAX_FILE_BYTES && !content.subarray(0, 8000).includes(0);
}

export class NotReviewableError extends Error {}

/**
 * Text of `path` at the given snapshot id: from the local object store, else from git (with smudge filters, so it
 * matches the working tree form). `null` when the id is absent, meaning the file did not exist.
 */
export function readBaselineText(root: string, store: LocalStore, path: string, id: string | undefined): string | null {
  if (id === undefined) return null;
  let content: Buffer;
  if (id.startsWith(LARGE_ID)) throw new NotReviewableError(path);
  const stored = store.readObject(id);
  if (stored !== null) content = stored;
  else {
    try {
      content = execFileSync("git", ["cat-file", "--filters", `--path=${path}`, id], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    } catch {
      throw new Error(`The content of ${path} at begin is no longer available. Cancel this run and begin again.`);
    }
  }
  if (!isReviewable(content)) throw new NotReviewableError(path);
  return content.toString("utf8");
}

/** Current working tree text of `path`, or `null` if it was deleted. */
export function readWorkingText(root: string, path: string): string | null {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return null;
  const content = readFileSync(absolute);
  if (!isReviewable(content)) throw new NotReviewableError(path);
  return content.toString("utf8");
}

/** Local state lives under `localDir`; reviewed source and copies of uncommitted files stay out of git. */
export class LocalStore {
  private readonly base: string;

  constructor(root: string, config: Config) {
    this.base = join(root, config.localDir);
  }

  objectPath(id: string): string {
    if (!/^[a-f0-9]{40,64}$/.test(id)) throw new Error(`Invalid object id ${id}.`);
    return join(this.base, "objects", id);
  }

  saveObject(id: string, content: Buffer): void {
    const path = this.objectPath(id);
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }

  readObject(id: string): Buffer | null {
    const path = this.objectPath(id);
    return existsSync(path) ? readFileSync(path) : null;
  }

  /**
   * Deletes finished runs untouched for `days`, sessions bound to them, their work folders, and objects no remaining
   * run references. Unreferenced objects younger than an hour are kept: a concurrent `begin` may not have saved its run yet.
   */
  prune(days: number, now = Date.now()): { runs: number; objects: number } {
    const runs = join(this.base, "runs");
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const kept = new Set<string>();
    const referenced = new Set<string>();
    let removedRuns = 0;
    for (const name of existsSync(runs) ? readdirSync(runs).filter((file) => file.endsWith(".json")) : []) {
      const path = join(runs, name);
      const run = readJson(path) as Partial<Run>;
      const id = name.slice(0, -".json".length);
      if (FINISHED_PHASES.has(run.phase ?? "") && statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        rmSync(join(this.base, "work", id), { recursive: true, force: true });
        removedRuns += 1;
        continue;
      }
      kept.add(id);
      if (run.schemaVersion === RUN_SCHEMA_VERSION) for (const value of Object.values(run.baseline ?? {})) referenced.add(value);
    }
    const sessions = join(this.base, "sessions");
    for (const name of existsSync(sessions) ? readdirSync(sessions) : []) {
      const { runId } = readJson(join(sessions, name)) as { runId: string };
      if (!kept.has(runId)) rmSync(join(sessions, name), { force: true });
    }
    const objects = join(this.base, "objects");
    let removedObjects = 0;
    for (const name of existsSync(objects) ? readdirSync(objects) : []) {
      const path = join(objects, name);
      if (referenced.has(name) || statSync(path).mtimeMs > now - 60 * 60 * 1000) continue;
      rmSync(path, { force: true });
      removedObjects += 1;
    }
    return { runs: removedRuns, objects: removedObjects };
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
    const run = readJson(path) as Partial<Run>;
    if (run.schemaVersion !== RUN_SCHEMA_VERSION) {
      throw new Error(`Run ${id} was written by an older rated-review-loop and cannot be continued. Begin a new run.`);
    }
    return run as Run;
  }

  saveRun(run: Run): void {
    writeJsonAtomic(this.runPath(run.id), run);
  }

  /** The run bound to a session, if any. Pruned runs and runs from older versions count as none. */
  active(key: string): Run | null {
    const path = this.sessionPath(key);
    if (!existsSync(path)) return null;
    const { runId } = readJson(path) as { runId: string };
    const runPath = this.runPath(runId);
    if (!existsSync(runPath) || (readJson(runPath) as Partial<Run>).schemaVersion !== RUN_SCHEMA_VERSION) return null;
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
