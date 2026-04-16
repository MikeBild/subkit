// `subkit executions ...`

import { readSse } from "@cli-core/index.ts";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne, printJson } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List executions" },
  args: {
    ...clientArgs,
    workflow: { type: "string", description: "Filter by workflow id" },
    status: { type: "string", description: "Filter by status" },
    limit: { type: "string", description: "Max rows" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const query: Record<string, string | number | undefined> = {};
    if (typeof args.workflow === "string" && args.workflow) query.workflow_id = args.workflow;
    if (typeof args.status === "string" && args.status) query.status = args.status;
    if (typeof args.limit === "string" && args.limit) query.limit = Number(args.limit);
    const body = await client.listExecutions(query);
    emitList(
      asJson,
      ["id", "workflow_id", "status", "request_source", "started_at", "finished_at"],
      body.items as unknown as Record<string, unknown>[],
    );
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch an execution" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Execution id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.getExecution(args.id as string);
    emitOne(asJson, row as unknown as Record<string, unknown>);
  },
});

const logsCmd = defineCommand({
  meta: { name: "logs", description: "List steps of an execution" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Execution id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.executionSteps(args.id as string);
    if (asJson) {
      printJson(body.items);
      return;
    }
    for (const step of body.items) {
      const s = step as Record<string, unknown>;
      process.stdout.write(`${s.step_key}\t${s.kind}\t${s.status}\t${s.duration_ms ?? ""}ms\n`);
    }
  },
});

const abortCmd = defineCommand({
  meta: { name: "abort", description: "Cancel an in-flight execution" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Execution id", required: true },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    await client.cancelExecution(args.id as string);
    process.stdout.write(`cancel requested for ${args.id}\n`);
  },
});

const tailCmd = defineCommand({
  meta: { name: "tail", description: "Tail an execution's SSE stream" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Execution id", required: true },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    const res = await client.stream(`/v1/executions/${args.id}/stream`);
    if (!res.ok) {
      process.stderr.write(`stream error: ${res.status} ${res.statusText}\n`);
      process.exitCode = 2;
      return;
    }
    await readSse(res, (frame) => {
      process.stdout.write(`[${frame.event}] ${frame.data}\n`);
    });
  },
});

export const executionsCommand = defineCommand({
  meta: { name: "executions", description: "Execution inspection + tail" },
  subCommands: { list: listCmd, get: getCmd, logs: logsCmd, abort: abortCmd, tail: tailCmd },
});
