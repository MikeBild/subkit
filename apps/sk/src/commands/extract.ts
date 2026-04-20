import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

export const extractCommand = defineCommand({
  meta: { name: "extract", description: "Extract structured JSON from a sample file" },
  args: {
    file: { type: "positional", required: true, description: "Path to sample file" },
    hint: { type: "string", description: "Hint to the extractor" },
  },
  async run({ args }) {
    const { readFileSync } = await import("node:fs");
    const profile = resolveProfile();
    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });
    try {
      const sample = readFileSync(String(args.file), "utf8");
      const extractBody: { sample: string; hint?: string } = { sample };
      if (args.hint) extractBody.hint = String(args.hint);
      const result = await client.extract(extractBody);
      printJson(result);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});
