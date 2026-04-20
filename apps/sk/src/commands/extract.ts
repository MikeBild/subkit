import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

export const extractCommand = defineCommand({
  meta: { name: "extract", description: "Extract structured data from text using AI" },
  args: {
    sample: { type: "string", required: true, description: "Text to extract from" },
    hint: { type: "string", description: "Extraction hint / schema description" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const profile = resolveProfile();
    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });
    try {
      const extractBody: { sample: string; hint?: string } = { sample: args.sample as string };
      if (args.hint) extractBody.hint = args.hint as string;
      const result = await client.extract(extractBody);
      printJson(result);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});
