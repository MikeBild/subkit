import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { readSse } from "@cli-core/sse.ts";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List executions" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    status: { type: "string", description: "Filter by status" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const query: Record<string, string | number | undefined> = { limit: Number(args.limit) };
      if (args.status) query.status = args.status;
      const { items } = await client.listExecutions(query);
      emitList(
        !!args.json,
        ["id", "workflow_id", "status", "started_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an execution by id" },
  args: {
    id: { type: "positional", required: true, description: "Execution id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const execution = await client.getExecution(args.id);
      printJson(execution);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const stepsCommand = defineCommand({
  meta: { name: "steps", description: "List steps for an execution" },
  args: {
    id: { type: "positional", required: true, description: "Execution id" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.executionSteps(args.id);
      // Flatten request_meta so operators can see, at a glance, which URL
      // was hit with what status, size, retry count, and which auth method
      // actually applied to the request.
      const rows = (items as Record<string, unknown>[]).map((s) => {
        const rm = (s.request_meta ?? null) as Record<string, unknown> | null;
        const conn = (rm?.connector ?? null) as Record<string, unknown> | null;
        return {
          ...s,
          url: (rm?.url as string | undefined) ?? "—",
          status_code: (rm?.status as number | undefined) ?? "—",
          bytes_in: (rm?.bytes_in as number | undefined) ?? "—",
          auth_method: (conn?.auth_method as string | undefined) ?? "—",
        };
      });
      emitList(
        !!args.json,
        [
          "step_id",
          "name",
          "status",
          "duration_ms",
          "url",
          "status_code",
          "bytes_in",
          "auth_method",
        ],
        rows,
      );
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const abortCommand = defineCommand({
  meta: { name: "abort", description: "Abort a running execution" },
  args: {
    id: { type: "positional", required: true, description: "Execution id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      await client.abortExecution(args.id);
      process.stdout.write(`${pc.green("aborted")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const tailCommand = defineCommand({
  meta: { name: "tail", description: "Stream live output from an execution" },
  args: {
    id: { type: "positional", required: true, description: "Execution id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const resp = await client.streamExecution(args.id);
      if (!resp.body) {
        process.stderr.write("no stream\n");
        return;
      }
      await readSse(resp, (frame) => {
        if (frame.data) process.stdout.write(`${frame.data}\n`);
      });
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

export const executionsCommand = defineCommand({
  meta: { name: "executions", description: "Manage workflow executions" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    steps: stepsCommand,
    abort: abortCommand,
    tail: tailCommand,
  },
});
