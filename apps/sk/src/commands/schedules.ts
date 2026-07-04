// `sk schedules` — manage scheduled workflow runs.
//
// Full lifecycle from the CLI: list, create (upserts the workflow's
// single schedule), update, pause/resume, delete. Thin wrappers over
// the /v1/schedules HTTP surface; the reconciler picks up any change
// within its 60s pass.

import { reportCommandError } from "@cli-core/errors";
import { emitList, emitOne } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient, type ScheduleEntry } from "../engine-client.ts";

function makeClient(): EngineClient {
  const { engine_url, api_key, active_tenant_id } = resolveProfile();
  return new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
}

const SCHEDULE_COLUMNS = ["workflow_slug", "cron", "timezone", "paused", "id"];

function emitSchedule(json: boolean, row: ScheduleEntry): void {
  emitOne(json, row as unknown as Record<string, unknown>);
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List scheduled workflow runs" },
  args: {
    workflow: { type: "string", description: "Filter by workflow id" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const { schedules, total } = await makeClient().listSchedules(
        args.workflow ? { workflow_id: args.workflow } : {},
      );
      emitList(!!args.json, SCHEDULE_COLUMNS, schedules as unknown as Record<string, unknown>[]);
      // Schedules are a bounded catalog — the list IS complete; say so.
      if (!args.json) {
        process.stdout.write(`${total} schedule${total === 1 ? "" : "s"} total\n`);
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const createCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Schedule a workflow (a workflow carries at most one schedule; re-create updates it)",
  },
  args: {
    workflow: { type: "string", description: "Workflow id", required: true },
    cron: {
      type: "string",
      description: '5-field cron or "every:<seconds>" (e.g. "0 8 * * *")',
      required: true,
    },
    timezone: { type: "string", description: "IANA timezone (default UTC)" },
    paused: { type: "boolean", description: "Create in paused state", default: false },
    input: { type: "string", description: "JSON input payload passed to every run" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const body: Parameters<EngineClient["createSchedule"]>[0] = {
        workflow_id: args.workflow,
        cron: args.cron,
      };
      if (args.timezone) body.timezone = args.timezone;
      if (args.paused) body.paused = true;
      if (args.input) body.input = JSON.parse(args.input);
      const row = await makeClient().createSchedule(body);
      emitSchedule(!!args.json, row);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update a schedule's cron, timezone, or input" },
  args: {
    id: { type: "positional", description: "Schedule id", required: true },
    cron: { type: "string", description: "New cron expression" },
    timezone: { type: "string", description: "New IANA timezone" },
    input: { type: "string", description: "New JSON input payload" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const patch: Parameters<EngineClient["updateSchedule"]>[1] = {};
      if (args.cron) patch.cron = args.cron;
      if (args.timezone) patch.timezone = args.timezone;
      if (args.input) patch.input = JSON.parse(args.input);
      const row = await makeClient().updateSchedule(String(args.id), patch);
      emitSchedule(!!args.json, row);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

function pauseResumeCommand(paused: boolean) {
  const name = paused ? "pause" : "resume";
  return defineCommand({
    meta: {
      name,
      description: paused ? "Pause a schedule (keeps the row)" : "Resume a paused schedule",
    },
    args: {
      id: { type: "positional", description: "Schedule id", required: true },
      json: { type: "boolean", description: "JSON output", default: false },
    },
    async run({ args }) {
      try {
        const row = await makeClient().updateSchedule(String(args.id), { paused });
        emitSchedule(!!args.json, row);
      } catch (err) {
        reportCommandError(err, { json: Boolean(args.json) });
      }
    },
  });
}

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a schedule" },
  args: {
    id: { type: "positional", description: "Schedule id", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const out = await makeClient().deleteSchedule(String(args.id));
      if (args.json) process.stdout.write(`${JSON.stringify(out)}\n`);
      else process.stdout.write(`deleted ${out.id}\n`);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

export const schedulesCommand = defineCommand({
  meta: { name: "schedules", description: "Scheduled workflow runs" },
  subCommands: {
    list: listCommand,
    create: createCommand,
    update: updateCommand,
    pause: pauseResumeCommand(true),
    resume: pauseResumeCommand(false),
    delete: deleteCommand,
  },
  // Bare `sk schedules` behaves like `sk schedules list` — the common ask.
  async run(ctx) {
    if (ctx.args._.length === 0) {
      await listCommand.run?.({ args: { workflow: undefined, json: false, _: [] } } as never);
    }
  },
});
