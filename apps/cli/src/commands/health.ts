// `subkit health` — GET /v1/health.
//
// Exposed both as a citty CommandDef (the main CLI dispatches this) and
// as a bare `run()` function so tests can invoke it directly with a
// stubbed client, without spawning a subprocess.

import { defineCommand } from "citty";
import type { EngineClient, SetupValidationResponse } from "../engine-client.ts";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

function emitSetup(setup: SetupValidationResponse): void {
  process.stdout.write("\n");
  emitOne(false, {
    setup_status: setup.overall_status,
    setup_issues: setup.issues.length,
    setup_recommendations: setup.recommendations.length,
  });
  if (setup.issues.length > 0) {
    process.stdout.write("\n");
    emitList(false, ["id", "severity", "title", "detail"], setup.issues);
  }
}

export async function runHealth(
  client: EngineClient,
  asJson: boolean,
  includeSetup = false,
): Promise<number> {
  const body = await client.health();
  const payload: Record<string, unknown> = {
    status: body.status,
    version: body.version,
    db_connected: body.db_connected,
    uptime_seconds: body.uptime_seconds,
  };
  if (includeSetup) {
    const setup = await client.setupValidation();
    if (asJson) {
      emitOne(true, { ...payload, setup });
    } else {
      emitOne(false, payload);
      emitSetup(setup);
    }
    return 0;
  }
  emitOne(asJson, payload);
  return 0;
}

export const healthCommand = defineCommand({
  meta: { name: "health", description: "Engine health + db probe" },
  args: {
    ...clientArgs,
    setup: { type: "boolean", description: "Also validate live runtime setup" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await runHealth(client, asJson, Boolean(args.setup));
  },
});
