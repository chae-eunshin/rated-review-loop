import { dirname, relative } from "node:path";

import { clientOfMode } from "./config.ts";
import { packet, submit, type Context, type SubmitResult } from "./cycle.ts";
import { CLI_REVIEWERS, reviewPrompt, spawnProcess, type Spawn } from "./reviewers/index.ts";
import { writeJsonAtomic } from "./store.ts";

/** Has the configured CLI review a run that passed its checks, then records the report like `submit`. */
export function reviewWithCli(ctx: Context, id: string, spawn: Spawn = spawnProcess): SubmitResult {
  const run = ctx.store.readRun(id);
  if (run.phase !== "awaiting-review") throw new Error("This run is not awaiting review.");
  const client = clientOfMode(ctx.config.reviewer.mode);
  if (client === null) throw new Error('reviewer.mode is "session": the coding agent reviews and submits directly.');
  const packetPath = ctx.store.workPath(id, "packet.json");
  writeJsonAtomic(packetPath, packet(ctx, id));
  const result = CLI_REVIEWERS[client].review(
    {
      root: ctx.root,
      packetPath,
      workDir: dirname(packetPath),
      prompt: reviewPrompt(ctx.root, ctx.config, relative(ctx.root, packetPath)),
      ...(ctx.config.reviewer.model !== undefined ? { model: ctx.config.reviewer.model } : {}),
    },
    spawn,
  );
  return submit(ctx, id, result.report, result.reviewer);
}
