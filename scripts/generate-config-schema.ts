/**
 * Writes config.schema.json from the zod schema the CLI validates the config with, so the two cannot drift.
 * A test fails when the committed file is out of date; run `pnpm generate:schema` to refresh it.
 */
import { writeFileSync } from "node:fs";

import { CONFIG_JSON_SCHEMA } from "../src/config.ts";

export const CONFIG_SCHEMA_FILE = new URL("../config.schema.json", import.meta.url);

export function configSchemaText(): string {
  return `${JSON.stringify(CONFIG_JSON_SCHEMA, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  writeFileSync(CONFIG_SCHEMA_FILE, configSchemaText());
  process.stdout.write("Wrote config.schema.json\n");
}
