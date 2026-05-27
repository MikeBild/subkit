import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { readSse } from "@cli-core/sse.ts";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { collectFileRefs } from "../utils/file-ref.ts";

/** Compact human-readable byte formatter (matches files.ts / audit). */
function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Walk an execution payload's step outputs, collect every `$file`
 *  reference, and print a one-line summary per fid with a hint at how
 *  to download. Silent when no refs are present. Stays out of the JSON
 *  surface — only the text rendering changes. */
async function maybePrintOutputFiles(
  client: EngineClient,
  execution: Record<string, unknown>,
): Promise<void> {
  // The full execution payload may carry `result`, `output`,
  // `steps[*].output`, or `step_outputs` — collect from the whole
  // object to stay resilient to engine-side renames.
  const fids = new Set<string>();
  for (const ref of collectFileRefs(execution)) fids.add(ref);
  if (fids.size === 0) return;
  process.stdout.write(`\n${pc.bold("Output files:")}\n`);
  for (const fid of fids) {
    try {
      const row = await client.getFile(fid);
      process.stdout.write(
        `  ${fid} (${row.filename}, ${humanBytes(row.size_bytes)}) — sk files download ${fid}\n`,
      );
    } catch {
      // The file may have been soft-deleted or the principal lacks
      // file:read; print the fid plus a hint so the operator still
      // sees the reference exists.
      process.stdout.write(`  ${fid} — sk files download ${fid}\n`);
    }
  }
}

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
    json: { type: "boolean", description: "JSON-only (skip Output files line)", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const execution = await client.getExecution(args.id);
      printJson(execution);
      // Text-output surfaces an extra `Output files:` block per
      // `$file` ref found anywhere in the execution payload. JSON
      // output stays unchanged so script consumers see no drift.
      if (!args.json) {
        await maybePrintOutputFiles(client, execution as Record<string, unknown>);
      }
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

const rerunCommand = defineCommand({
  meta: {
    name: "rerun",
    description:
      "Re-run a previous execution against the workflow + input it carried. Useful after diagnose/repair.",
  },
  args: {
    id: { type: "positional", required: true, description: "Execution id to rerun" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const prior = (await client.getExecution(args.id)) as Record<string, unknown>;
      const workflow_id = typeof prior.workflow_id === "string" ? prior.workflow_id : undefined;
      if (!workflow_id) {
        process.stderr.write(
          `execution ${args.id} is not bound to a saved workflow (source_kind=${prior.source_kind ?? "unknown"}); rerun requires a saved workflow.\n`,
        );
        process.exit(1);
      }
      const sourceRef = (prior.source_ref ?? null) as Record<string, unknown> | null;
      const priorInput = sourceRef?.input;
      const body = {
        source: "saved" as const,
        workflow_id,
        ...(priorInput !== undefined ? { input: priorInput } : {}),
        request_source: "cli" as const,
      };
      printJson(await client.runExecution(body));
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
    rerun: rerunCommand,
  },
});
