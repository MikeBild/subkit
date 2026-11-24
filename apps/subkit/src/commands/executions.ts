import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import type {
  ExecutionDetail,
  ExecutionListItem,
  ExecutionListQuery,
  ExecutionStep,
} from "../engine-client/executions.ts";
import { EngineClient, type ExecutionCost } from "../engine-client.ts";
import { executionOutcomeLine, recordLinkLines, stepLimitLine } from "../lib/execution-outcome.ts";
import { resolveExecutionResult } from "../lib/execution-result.ts";
import { heldRunBlock } from "../lib/held-run.ts";
import { pickId } from "../lib/pick.ts";
import { exitCodeForTerminalStatus, tailExecution } from "../lib/tail-execution.ts";
import {
  computeStepBottlenecks,
  executionDurationMs,
  formatTokens,
  humanMs,
} from "../render/format.ts";
import { collectFileRefs } from "../utils/file-ref.ts";
import { withCommandErrors } from "./command-runtime.ts";
import { resolveTime } from "./stats.ts";

const fetchExecutionRows = async (client: EngineClient) => {
  const { items } = await client.listExecutions({ limit: 20 });
  return items.map((r) => ({
    id: r.id,
    name: r.workflow_id,
    detail: r.status,
  }));
};

export function originOf(row: Pick<ExecutionListItem, "source_kind" | "request_source">): string {
  if (row.source_kind === "draft" || row.source_kind === "step") return "authoring";
  if (row.request_source === "scheduler") return "scheduled";
  return "manual";
}

function fieldOf(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function stringField(value: unknown, key: string): string | null {
  const field = fieldOf(value, key);
  return typeof field === "string" ? field : null;
}

export function executionListQuery(
  args: {
    limit: string;
    status?: string | undefined;
    source?: string | undefined;
    parent?: string | undefined;
    cursor?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
  nowMs: number,
): ExecutionListQuery {
  const query: ExecutionListQuery = { limit: Number(args.limit) };
  if (args.status) query.status = args.status;
  if (args.source) query.request_source = String(args.source);
  if (args.parent) query.parent_execution_id = String(args.parent);
  if (args.cursor) query.cursor = String(args.cursor);
  if (args.from) query.started_from = resolveTime(String(args.from), nowMs).toISOString();
  if (args.to) query.started_to = resolveTime(String(args.to), nowMs).toISOString();
  return query;
}

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

async function maybePrintOutputFiles(
  client: EngineClient,
  execution: ExecutionDetail,
): Promise<void> {
  const fids = new Set<string>();
  for (const ref of collectFileRefs(execution)) fids.add(ref);
  if (fids.size === 0) return;
  process.stdout.write(`\n${pc.bold("Output files:")}\n`);
  for (const fid of fids) {
    try {
      const row = await client.getFile(fid);
      process.stdout.write(
        `  ${fid} (${row.filename}, ${humanBytes(row.size_bytes)}) — subkit files download ${fid}\n`,
      );
    } catch {
      process.stdout.write(`  ${fid} — subkit files download ${fid}\n`);
    }
  }
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List executions" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    status: { type: "string", description: "Filter by status" },
    source: {
      type: "string",
      description: "Filter by request source (e.g. scheduler, cli, api, mcp, chat)",
    },
    parent: {
      type: "string",
      description: "Lineage filter: list the reruns spawned from this execution id",
    },
    from: {
      type: "string",
      description:
        "Only runs that started at or after this instant (ISO-8601 or now-24h, now-7d, startOfMonth)",
    },
    to: {
      type: "string",
      description: "Only runs that started before this instant (exclusive; default: open)",
    },
    cursor: {
      type: "string",
      description: "Continue after a previous page (the next_cursor it printed)",
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const { items, total, next_cursor } = await client.listExecutions(
          executionListQuery(args, Date.now()),
        );
        const rows = items.map((r) => {
          const ms = executionDurationMs(r.started_at, r.finished_at);
          const running = r.finished_at == null && r.started_at != null;
          return {
            ...r,
            origin: originOf(r),
            duration: ms != null ? humanMs(ms) : running ? "running" : "—",
          };
        });
        emitList(
          !!args.json,
          ["id", "workflow_id", "origin", "status", "duration", "started_at"],
          rows,
        );
        if (!args.json) {
          process.stdout.write(
            next_cursor
              ? `${pc.dim(`showing ${items.length} of ${total} executions — next page: --cursor ${next_cursor}`)}\n`
              : `${pc.dim(`${total} execution${total === 1 ? "" : "s"} total`)}\n`,
          );
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an execution by id" },
  args: {
    id: { type: "positional", required: false, description: "Execution id" },
    json: { type: "boolean", description: "JSON-only (skip Output files line)", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const id = await pickId({
          label: "execution id",
          argValue: args.id,
          fetch: () => fetchExecutionRows(client),
        });
        const execution = await client.getExecution(id);
        printJson(execution);
        if (!args.json) {
          let steps: ExecutionStep[] = [];
          try {
            const res = await client.executionSteps(id);
            steps = res.items;
          } catch {}
          try {
            const cost = await client.executionCost(id);
            printExecutionCostCard(cost);
          } catch {}
          printStepBottlenecks(steps);
          const outcomeLine = executionOutcomeLine(execution.outcome);
          if (outcomeLine) process.stderr.write(`\n${pc.dim("outcome:")} ${outcomeLine}\n`);
          for (const line of recordLinkLines(execution.record_links))
            process.stderr.write(`${pc.dim("record:")} ${line}\n`);
          const held = heldRunBlock(client, execution, steps);
          if (held) process.stderr.write(`\n${pc.bold(pc.yellow(held))}\n`);
          if (execution.status === "failed" || execution.status === "timed_out") {
            printFailedStepErrors(steps);
          }
          await maybePrintOutputFiles(client, execution);
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

const resultCommand = defineCommand({
  meta: {
    name: "result",
    description: "Print the final output a workflow execution produced",
  },
  args: {
    id: { type: "positional", required: false, description: "Execution id" },
    json: { type: "boolean", description: "JSON-only output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const id = await pickId({
          label: "execution id",
          argValue: args.id,
          fetch: () => fetchExecutionRows(client),
        });
        const execution = await client.getExecution(id);
        const { items: steps } = await client.executionSteps(id);
        const result = resolveExecutionResult(execution, steps);
        if (args.json) {
          printJson(
            result.kind === "markdown"
              ? { result_markdown: result.markdown, result_markdown_truncated: result.truncated }
              : result.output,
          );
          return;
        }
        const held = heldRunBlock(client, execution, steps);
        process.stdout.write(`execution ${id} · ${execution.status}\n`);
        if (held) process.stderr.write(`\n${pc.bold(pc.yellow(held))}\n`);
        if (result.kind === "markdown") {
          process.stdout.write(`${result.markdown}\n`);
          if (result.truncated)
            process.stderr.write(`\n${pc.dim("note:")} result truncated at 64 KiB\n`);
          return;
        }
        if (result.output === null || result.output === undefined) {
          process.stdout.write(
            result.storageUri
              ? `  result offloaded to ${result.storageUri}\n`
              : "  (no output recorded)\n",
          );
          return;
        }
        printJson(result.output);
      },
      { json: Boolean(args.json) },
    );
  },
});

const stepsCommand = defineCommand({
  meta: { name: "steps", description: "List steps for an execution" },
  args: {
    id: { type: "positional", required: false, description: "Execution id" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const id = await pickId({
          label: "execution id",
          argValue: args.id,
          fetch: () => fetchExecutionRows(client),
        });
        const { items } = await client.executionSteps(id);
        const rows = items.map((s) => ({
          ...s,
          url: fieldOf(s.request_meta, "url") ?? "—",
          status_code: fieldOf(s.request_meta, "status") ?? "—",
          bytes_in: fieldOf(s.request_meta, "bytes_in") ?? "—",
          auth_method: fieldOf(fieldOf(s.request_meta, "connector"), "auth_method") ?? "—",
          error: fieldOf(s.error, "code") ?? "—",
        }));
        emitList(
          !!args.json,
          ["step_key", "status", "duration_ms", "url", "status_code", "error", "auth_method"],
          rows,
        );
        if (!args.json) {
          printFailedStepErrors(items);
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

function printExecutionCostCard(cost: ExecutionCost): void {
  const { llm, external } = cost;
  if (llm.calls === 0 && external.calls === 0) return;
  process.stdout.write(`\n${pc.bold("Cost:")}\n`);
  if (llm.calls > 0) {
    process.stdout.write(
      `  ${pc.cyan("llm")}      ${formatTokens(llm.weighted_tokens)} weighted` +
        ` · ${llm.cache_read_pct.toFixed(0)}% cache-read` +
        ` · ${llm.calls} call${llm.calls === 1 ? "" : "s"}` +
        ` · ${humanMs(llm.latency_ms)}\n`,
    );
    const flows = [...llm.by_flow].sort((a, b) => b.weighted_tokens - a.weighted_tokens);
    for (const f of flows) {
      process.stdout.write(
        `    ${pc.dim(f.flow.padEnd(16))} ${formatTokens(f.weighted_tokens)} weighted` +
          ` · ${f.calls} call${f.calls === 1 ? "" : "s"} · ${humanMs(f.latency_ms)}\n`,
      );
    }
  }
  if (external.calls > 0) {
    const cost_usd = external.cost_usd > 0 ? ` · $${external.cost_usd.toFixed(4)}` : "";
    process.stdout.write(
      `  ${pc.cyan("external")} ${external.calls} call${external.calls === 1 ? "" : "s"}` +
        ` · ${external.units} unit${external.units === 1 ? "" : "s"}${cost_usd}` +
        ` · ${humanMs(external.latency_ms)}\n`,
    );
  }
}

function printStepBottlenecks(steps: readonly ExecutionStep[]): void {
  const ranked = computeStepBottlenecks(steps);
  if (ranked.length === 0) return;
  process.stdout.write(`\n${pc.bold("Bottlenecks:")} ${pc.dim("(share of total step time)")}\n`);
  for (const s of ranked) {
    const conn = s.connector_slug ? ` ${pc.dim(`(${s.connector_slug})`)}` : "";
    const bar = "█".repeat(Math.max(1, Math.round(s.pct / 5)));
    process.stdout.write(
      `  ${pc.cyan(s.step_key.padEnd(20))} ${humanMs(s.duration_ms).padStart(7)}` +
        ` ${String(s.pct.toFixed(1)).padStart(5)}%  ${pc.dim(bar)}${conn}\n`,
    );
  }
}

function printFailedStepErrors(steps: readonly ExecutionStep[]): void {
  const failed = steps.filter(
    (s) => (s.status === "failed" || s.status === "timed_out") && s.error,
  );
  if (failed.length === 0) return;
  process.stdout.write(`\n${pc.bold(pc.red("Failures:"))}\n`);
  for (const s of failed) {
    const stepKey = s.step_key;
    const code = stringField(s.error, "code") ?? "error";
    const message = stringField(s.error, "message") ?? "";
    const guidance = stringField(s.error, "guidance");
    const resolvedUrl = stringField(s.error, "resolved_url");
    process.stdout.write(`  ${pc.red("●")} ${pc.bold(stepKey)} — ${pc.red(code)}: ${message}\n`);
    if (resolvedUrl) process.stdout.write(`      ${pc.dim(`url: ${resolvedUrl}`)}\n`);
    const limit = stepLimitLine(s);
    if (limit) process.stdout.write(`      ${pc.yellow(limit)}\n`);
    if (guidance) process.stdout.write(`      ${pc.yellow(guidance)}\n`);
  }
}

const abortCommand = defineCommand({
  meta: { name: "abort", description: "Abort a running execution" },
  args: {
    id: { type: "positional", required: false, description: "Execution id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      await client.abortExecution(id);
      process.stdout.write(`${pc.green("aborted")}\n`);
    });
  },
});

const rerunCommand = defineCommand({
  meta: {
    name: "rerun",
    description:
      "Re-run a previous execution against the workflow + input it carried. Useful after diagnose/repair.",
  },
  args: {
    id: { type: "positional", required: false, description: "Execution id to rerun" },
    input: {
      type: "string",
      description: "Override the original input (JSON string). Omit to reuse it verbatim.",
    },
    follow: {
      type: "boolean",
      description: "Queue the rerun and stream its progress live (step-by-step JSON lines).",
    },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    let inputOverride: unknown;
    if (args.input) {
      try {
        inputOverride = JSON.parse(String(args.input));
      } catch (err) {
        process.stderr.write(
          `invalid JSON for --input: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    }
    return withCommandErrors(async () => {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      const body = {
        ...(inputOverride !== undefined ? { input: inputOverride } : {}),
        ...(args.follow ? { async: true } : {}),
      };
      const result = await client.rerunExecution(id, body);
      if (args.follow) {
        process.stderr.write(`execution ${result.execution_id} queued — following\n`);
        const terminal = await tailExecution(client, result.execution_id);
        process.exitCode = exitCodeForTerminalStatus(terminal);
        return;
      }
      printJson(result);
      process.stderr.write(
        `\n${pc.dim("Tip:")} subkit executions list --parent ${id} shows this rerun lineage\n`,
      );
    });
  },
});

const tailCommand = defineCommand({
  meta: { name: "tail", description: "Stream live output from an execution" },
  args: {
    id: { type: "positional", required: false, description: "Execution id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      const terminal = await tailExecution(client, id);
      process.exitCode = exitCodeForTerminalStatus(terminal);
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
    show: getCommand,
    result: resultCommand,
    steps: stepsCommand,
    abort: abortCommand,
    tail: tailCommand,
    rerun: rerunCommand,
  },
});
