// `subkit health` — GET /v1/health.
//
// Exposed both as a citty CommandDef (the main CLI dispatches this) and
// as a bare `run()` function so tests can invoke it directly with a
// stubbed client, without spawning a subprocess.

import { defineCommand } from "citty";
import type { EngineClient } from "../engine-client.ts";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitOne } from "../utils/format.ts";

export async function runHealth(client: EngineClient, asJson: boolean): Promise<number> {
  const body = await client.health();
  emitOne(asJson, {
    status: body.status,
    version: body.version,
    db_connected: body.db_connected,
    uptime_seconds: body.uptime_seconds,
  });
  return 0;
}

export const healthCommand = defineCommand({
  meta: { name: "health", description: "Engine health + db probe" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await runHealth(client, asJson);
  },
});
