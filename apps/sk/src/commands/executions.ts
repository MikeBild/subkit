import { exitCodeFor, reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient, type ExecutionCost } from "../engine-client.ts";
import { executionOutcomeLine } from "../lib/execution-outcome.ts";
import { pickId } from "../lib/pick.ts";
import { exitCodeForTerminalStatus, tailExecution } from "../lib/tail-execution.ts";
import {
  computeStepBottlenecks,
  executionDurationMs,
  formatTokens,
  humanMs,
} from "../render/format.ts";
import { collectFileRefs } from "../utils/file-ref.ts";

/** Candidate rows for the interactive execution picker (TTY only). */
const fetchExecutionRows = async (client: EngineClient) => {
  const { items } = await client.listExecutions({ limit: 20 });
  return (items as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: typeof r.workflow_id === "string" ? r.workflow_id : null,
    detail: typeof r.status === "string" ? r.status : null,
  }));
};

/** Where a run came from, mirroring the engine's operator digest:
 *  authoring trial-runs and manual test runs are NOT production
 *  incidents, so the list tags each row honestly. */
function originOf(row: Record<string, unknown>): string {
  const sourceKind = typeof row.source_kind === "string" ? row.source_kind : "saved";
  const reqSource = typeof row.request_source === "string" ? row.request_source : "";
  if (sourceKind === "draft" || sourceKind === "step") return "authoring";
  if (reqSource === "scheduler") return "scheduled";
  return "manual";
}

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
    source: {
      type: "string",
      description: "Filter by request source (e.g. scheduler, cli, api, mcp, chat)",
    },
    parent: {
      type: "string",
      description: "Lineage filter: list the reruns spawned from this execution id",
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const query: Record<string, string | number | undefined> = { limit: Number(args.limit) };
      if (args.status) query.status = args.status;
      if (args.source) query.request_source = String(args.source);
      if (args.parent) query.parent_execution_id = String(args.parent);
      const { items, total } = await client.listExecutions(query);
      // Tag each row by origin so authoring/manual trial-runs are not
      // mistaken for production incidents, and surface a wall-clock
      // duration (finished_at − started_at). A still-running row has no
      // finished_at → render "running" so the column never shows a bogus
      // zero. JSON output keeps the raw timestamps untouched; the derived
      // `duration` column is text-surface-only.
      const rows = (items as Record<string, unknown>[]).map((r) => {
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
      // Executions are an unbounded history — always say how big the
      // filtered set really is and how to page deeper.
      if (!args.json) {
        process.stdout.write(
          items.length < total
            ? `${pc.dim(`showing latest ${items.length} of ${total} executions — raise --limit to page deeper`)}\n`
            : `${pc.dim(`${total} execution${total === 1 ? "" : "s"} total`)}\n`,
        );
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
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
    try {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      const execution = await client.getExecution(id);
      printJson(execution);
      // Text-output surfaces an extra `Output files:` block per
      // `$file` ref found anywhere in the execution payload. JSON
      // output stays unchanged so script consumers see no drift.
      if (!args.json) {
        // Pull the steps once and reuse them for the failure block AND
        // the bottleneck view — the steps payload carries `duration_ms`.
        let steps: Record<string, unknown>[] = [];
        try {
          const res = await client.executionSteps(id);
          steps = res.items as Record<string, unknown>[];
        } catch {
          /* best-effort: telemetry blocks are decorative */
        }
        // Execution-cost card: weighted tokens, cache-read %, LLM
        // latency, external cost_usd (when non-zero), and a per-flow
        // breakdown. Best-effort — a 403 (no stats:read) or older engine
        // without the route simply omits the card.
        try {
          const cost = await client.executionCost(id);
          printExecutionCostCard(cost);
        } catch {
          /* best-effort: cost card is decorative */
        }
        // Step bottleneck view: each step's duration as a share of the
        // summed step duration, slowest-first.
        printStepBottlenecks(steps);
        // What happened, from the engine's structured outcome — a held
        // preview or a tolerated step failure both finalize "succeeded".
        const outcomeLine = executionOutcomeLine(
          (execution as { outcome?: Parameters<typeof executionOutcomeLine>[0] }).outcome,
        );
        if (outcomeLine) process.stderr.write(`\n${pc.dim("outcome:")} ${outcomeLine}\n`);
        // A failed execution is useless without the reason — print the
        // step errors inline instead of making the operator run
        // `executions steps … --json | grep`.
        if (execution.status === "failed") {
          printFailedStepErrors(steps);
        }
        await maybePrintOutputFiles(client, execution as Record<string, unknown>);
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
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
    try {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      const execution = (await client.getExecution(id)) as Record<string, unknown>;
      // The produced value lives on the final step's `output_preview`
      // (`result_preview` is its stringified form; large results are offloaded
      // to `result_storage_uri`). The execution row itself carries no output.
      const { items } = await client.executionSteps(id);
      const steps = items as Record<string, unknown>[];
      const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
      const output = last?.output_preview ?? last?.result_preview ?? null;
      if (args.json) {
        printJson(output);
        return;
      }
      const status = typeof execution.status === "string" ? execution.status : "unknown";
      process.stdout.write(`execution ${id} · ${status}\n`);
      if (output === null || output === undefined) {
        const uri = last?.result_storage_uri;
        process.stdout.write(
          typeof uri === "string" && uri
            ? `  result offloaded to ${uri}\n`
            : "  (no output recorded)\n",
        );
        return;
      }
      printJson(output);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
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
    try {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      const { items } = await client.executionSteps(id);
      // Flatten request_meta so operators can see, at a glance, which URL
      // was hit with what status, size, retry count, and which auth method
      // actually applied to the request. The `error` column carries the
      // failing step's code so the table no longer hides why a run failed.
      const rows = (items as Record<string, unknown>[]).map((s) => {
        const rm = (s.request_meta ?? null) as Record<string, unknown> | null;
        const conn = (rm?.connector ?? null) as Record<string, unknown> | null;
        const err = (s.error ?? null) as Record<string, unknown> | null;
        return {
          ...s,
          url: (rm?.url as string | undefined) ?? "—",
          status_code: (rm?.status as number | undefined) ?? "—",
          bytes_in: (rm?.bytes_in as number | undefined) ?? "—",
          auth_method: (conn?.auth_method as string | undefined) ?? "—",
          error: (err?.code as string | undefined) ?? "—",
        };
      });
      emitList(
        !!args.json,
        ["step_key", "status", "duration_ms", "url", "status_code", "error", "auth_method"],
        rows,
      );
      // The table truncates the error to a code. For failed steps,
      // print the full message + connector guidance below it — the most
      // actionable field, previously only reachable via `--json | grep`.
      if (!args.json) {
        printFailedStepErrors(items as Record<string, unknown>[]);
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

/** Execution-cost card: weighted tokens, cache-read %, summed LLM
 *  latency, external cost_usd (only when non-zero so a pure-LLM run
 *  doesn't render a noisy `$0.00` line), and a per-flow breakdown.
 *  No-op when there was no recorded LLM or external spend. */
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
    // Per-flow breakdown (e.g. authoring vs. execution vs. suggest-next)
    // sorted by weighted tokens so the dominant cost centre reads first.
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

/** Step bottleneck view: each step's `duration_ms` as a percentage of
 *  the summed step duration, slowest-first. No-op when no step carried a
 *  positive duration (e.g. a queued-only run). */
function printStepBottlenecks(steps: Record<string, unknown>[]): void {
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

/** Print a red error block for each failed step: code, message, and the
 *  connector-authored guidance hint. No-op when nothing failed. */
function printFailedStepErrors(steps: Record<string, unknown>[]): void {
  const failed = steps.filter((s) => s.status === "failed" && s.error);
  if (failed.length === 0) return;
  process.stdout.write(`\n${pc.bold(pc.red("Failures:"))}\n`);
  for (const s of failed) {
    const err = s.error as Record<string, unknown>;
    const stepKey = typeof s.step_key === "string" ? s.step_key : "(step)";
    const code = typeof err.code === "string" ? err.code : "error";
    const message = typeof err.message === "string" ? err.message : "";
    const guidance = typeof err.guidance === "string" ? err.guidance : null;
    const resolvedUrl = typeof err.resolved_url === "string" ? err.resolved_url : null;
    process.stdout.write(`  ${pc.red("●")} ${pc.bold(stepKey)} — ${pc.red(code)}: ${message}\n`);
    if (resolvedUrl) process.stdout.write(`      ${pc.dim(`url: ${resolvedUrl}`)}\n`);
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
    try {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      await client.abortExecution(id);
      process.stdout.write(`${pc.green("aborted")}\n`);
    } catch (err) {
      reportCommandError(err);
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
    try {
      const id = await pickId({
        label: "execution id",
        argValue: args.id,
        fetch: () => fetchExecutionRows(client),
      });
      // The engine pins the original workflow version, reuses its
      // persisted input, and links the new run via parent_execution_id.
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
        `\n${pc.dim("Tip:")} sk executions list --parent ${id} shows this rerun lineage\n`,
      );
    } catch (err) {
      reportCommandError(err);
    }
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
      // Shared with `sk workflows run --follow`: one JSON line per
      // event frame; the engine closes the stream after the terminal
      // frame and the exit code mirrors the run's outcome.
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
    result: resultCommand,
    steps: stepsCommand,
    abort: abortCommand,
    tail: tailCommand,
    rerun: rerunCommand,
  },
});
