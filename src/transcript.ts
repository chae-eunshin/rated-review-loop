import { existsSync, readFileSync } from "node:fs";

import { TranscriptModelSchema } from "./schemas.ts";

/**
 * Finds the model of the latest turn in a session transcript (JSON lines).
 * Hook payloads do not carry the model, but both clients write it to the transcript:
 * Claude Code as `message.model` on assistant lines, Codex as `payload.model` on turn context lines.
 */
export function modelFromTranscript(path: string | null | undefined): string {
  if (!path || !existsSync(path)) return "unknown";
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes('"model"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // A partially written last line is expected while the client is still running.
    }
    const entry = TranscriptModelSchema.safeParse(raw);
    if (entry.success) return "message" in entry.data ? entry.data.message.model : entry.data.payload.model;
  }
  return "unknown";
}
