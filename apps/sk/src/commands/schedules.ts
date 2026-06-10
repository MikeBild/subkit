// `sk schedules` — list scheduled workflow runs.
//
// Closes the surface gap where the engine + MCP exposed schedules
// (`list_schedules` tool, the reconciler firing them) but the CLI answered
// `sk schedules list` with "Unknown command" — observed in the production
// session that motivated the runtime-diagnosis work.

import { exitCodeFor } from "@cli-core/errors";
import { emitList } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List scheduled workflow runs" },
  args: {
    workflow: { type: "string", description: "Filter by workflow id" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { schedules } = await client.listSchedules(
        args.workflow ? { workflow_id: args.workflow } : {},
      );
      emitList(
        !!args.json,
        ["workflow_slug", "cron", "timezone", "paused", "id"],
        schedules as unknown as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

export const schedulesCommand = defineCommand({
  meta: { name: "schedules", description: "Scheduled workflow runs" },
  subCommands: { list: listCommand },
  // Bare `sk schedules` behaves like `sk schedules list` — the common ask.
  async run(ctx) {
    if (ctx.args._.length === 0) {
      await listCommand.run?.({ args: { workflow: undefined, json: false, _: [] } } as never);
    }
  },
});
