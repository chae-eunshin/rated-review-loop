import { existsSync, readFileSync } from "node:fs";

/**
 * Finds the model of the latest turn in a session transcript (JSON lines).
 * Hook payloads do not carry the model, but both clients write it to the transcript:
 * Claude Code as `message.model` on assistant lines, Codex as `payload.model` on turn context lines.
 */
export function modelFromTranscript(path: string | undefined): string {
  if (!path || !existsSync(path)) return "unknown";
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes('"model"')) continue;
    try {
      const entry = JSON.parse(line) as { message?: { model?: unknown }; payload?: { model?: unknown } };
      const model = entry.message?.model ?? entry.payload?.model;
      if (typeof model === "string" && model) return model;
    } catch {
      // A partially written last line is expected while the client is still running.
    }
  }
  return "unknown";
}
