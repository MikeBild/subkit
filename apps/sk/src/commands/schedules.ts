import { emitList, emitOne } from "@cli-core/format";
import { defineCommand } from "citty";
import type {
  ScheduleCreateBody,
  ScheduleUpdateBody,
  ScheduleWriteResponse,
} from "../engine-client/workflows.ts";
import { formatAutomationReadiness } from "../render/automation-readiness.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const SCHEDULE_COLUMNS = ["workflow_slug", "cron", "timezone", "execution_mode", "paused", "id"];

function emitSchedule(json: boolean, row: ScheduleWriteResponse): void {
  if (json) {
    emitOne(json, row);
    return;
  }
  const { automation_readiness, ...rest } = row;
  emitOne(json, rest);
  process.stderr.write(formatAutomationReadiness(automation_readiness));
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List scheduled workflow runs" },
  args: {
    workflow: { type: "string", description: "Filter by workflow id" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    return withCommandErrors(
      async () => {
        const { schedules, total } = await makeClient().listSchedules(
          args.workflow ? { workflow_id: args.workflow } : {},
        );
        emitList(!!args.json, SCHEDULE_COLUMNS, schedules);
        if (!args.json) {
          process.stdout.write(`${total} schedule${total === 1 ? "" : "s"} total\n`);
        }
      },
      { json: Boolean(args.json) },
    );
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
    executionMode: {
      type: "string",
      description: "Connector environment: dev or prod (default prod)",
      default: "prod",
    },
    paused: { type: "boolean", description: "Create in paused state", default: false },
    input: { type: "string", description: "JSON input payload passed to every run" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    return withCommandErrors(
      async () => {
        if (args.executionMode !== "dev" && args.executionMode !== "prod") {
          throw new Error("--execution-mode must be dev or prod");
        }
        const body: ScheduleCreateBody = {
          workflow_id: args.workflow,
          cron: args.cron,
        };
        if (args.timezone) body.timezone = args.timezone;
        if (args.executionMode === "dev" || args.executionMode === "prod") {
          body.execution_mode = args.executionMode;
        }
        if (args.paused) body.paused = true;
        if (args.input) body.input = JSON.parse(args.input);
        const row = await makeClient().createSchedule(body);
        emitSchedule(!!args.json, row);
      },
      { json: Boolean(args.json) },
    );
  },
});

const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update a schedule's cron, timezone, environment, or input",
  },
  args: {
    id: { type: "positional", description: "Schedule id", required: true },
    cron: { type: "string", description: "New cron expression" },
    timezone: { type: "string", description: "New IANA timezone" },
    executionMode: { type: "string", description: "New connector environment: dev or prod" },
    input: { type: "string", description: "New JSON input payload" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    return withCommandErrors(
      async () => {
        if (
          args.executionMode !== undefined &&
          args.executionMode !== "dev" &&
          args.executionMode !== "prod"
        ) {
          throw new Error("--execution-mode must be dev or prod");
        }
        const patch: ScheduleUpdateBody = {};
        if (args.cron) patch.cron = args.cron;
        if (args.timezone) patch.timezone = args.timezone;
        if (args.executionMode === "dev" || args.executionMode === "prod") {
          patch.execution_mode = args.executionMode;
        }
        if (args.input) patch.input = JSON.parse(args.input);
        const row = await makeClient().updateSchedule(String(args.id), patch);
        emitSchedule(!!args.json, row);
      },
      { json: Boolean(args.json) },
    );
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
      return withCommandErrors(
        async () => {
          const row = await makeClient().updateSchedule(String(args.id), { paused });
          emitSchedule(!!args.json, row);
        },
        { json: Boolean(args.json) },
      );
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
    return withCommandErrors(
      async () => {
        const out = await makeClient().deleteSchedule(String(args.id));
        if (args.json) process.stdout.write(`${JSON.stringify(out)}\n`);
        else process.stdout.write(`deleted ${out.id}\n`);
      },
      { json: Boolean(args.json) },
    );
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
  async run(ctx) {
    if (ctx.args._.length === 0) {
      await listCommand.run?.({ args: { workflow: undefined, json: false, _: [] } } as never);
    }
  },
});
