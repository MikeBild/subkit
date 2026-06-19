import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

export const healthCommand = defineCommand({
  meta: { name: "health", description: "Check engine health (no auth required)" },
  args: {
    "engine-url": { type: "string", description: "Engine base URL" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const profile = resolveProfile({ engine_url: args["engine-url"] as string | undefined });
    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });
    try {
      const h = await client.health();
      if (args.json) {
        printJson(h);
        return;
      }
      process.stdout.write(`status: ${h.status}\ndb:     ${h.db_connected}\n`);
    } catch (err) {
      process.stderr.write(`unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});
