import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import type { SetupValidationResponse, SetupValidationSection } from "../engine-client.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const errorsCommand = defineCommand({
  meta: { name: "errors", description: "Show recent engine errors" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    since: { type: "string", description: "ISO timestamp lower bound (UTC or numeric offset)" },
    "trace-id": { type: "string", description: "Filter by trace id" },
    tail: {
      type: "boolean",
      description: "Keep reading (not applicable — uses snapshot endpoint)",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const errQuery: { limit?: number; since?: string; trace_id?: string } = {
          limit: args.limit ? Number(args.limit) : 20,
        };
        if (args.since) errQuery.since = args.since as string;
        if (args["trace-id"]) errQuery.trace_id = args["trace-id"] as string;
        const { items, total_buffered } = await client.tailEngineErrors(errQuery);
        if (args.json) {
          printJson({ items, total_buffered });
          return;
        }
        if (items.length === 0) {
          process.stdout.write("no errors in buffer\n");
          return;
        }
        for (const e of items) {
          const status = e.status >= 500 ? pc.red(String(e.status)) : pc.yellow(String(e.status));
          process.stdout.write(
            `${pc.dim(e.ts)}  ${status}  ${pc.bold(e.code)}  ${e.message}${e.trace_id ? pc.dim(` [${e.trace_id}]`) : ""}\n`,
          );
        }
        if (total_buffered > items.length) {
          process.stdout.write(pc.dim(`... ${total_buffered - items.length} more in buffer\n`));
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

const llmCommand = defineCommand({
  meta: { name: "llm", description: "Show LLM diagnostics" },
  async run() {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.getDiagnosticsLlm());
    });
  },
});

function printSection(name: string, section: SetupValidationSection): void {
  const badge =
    section.status === "ok"
      ? pc.green("ok")
      : section.status === "warn"
        ? pc.yellow("warn")
        : pc.red("blocked");
  process.stdout.write(`\n${pc.bold(name.toUpperCase())}  ${badge}\n`);
  for (const v of section.values) {
    const hint = v.status_hint ? pc.dim(`  (${v.status_hint})`) : "";
    process.stdout.write(`  ${v.key.padEnd(28)} ${v.value ?? pc.dim("(unset)")}${hint}\n`);
  }
  for (const issue of section.issues) {
    const prefix = issue.severity === "blocker" ? pc.red("  [blocker]") : pc.yellow("  [warning]");
    process.stdout.write(`${prefix} ${issue.title}: ${issue.detail}\n`);
  }
  for (const rec of section.recommendations) {
    process.stdout.write(`  ${pc.cyan("→")} ${rec}\n`);
  }
}

const setupCommand = defineCommand({
  meta: { name: "setup", description: "Validate engine setup" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const result = await client.setupValidation();
        if (args.json) {
          printJson(result);
          return;
        }
        const overall =
          result.overall_status === "ok"
            ? pc.green("ok")
            : result.overall_status === "warn"
              ? pc.yellow("warn")
              : pc.red("blocked");
        process.stdout.write(
          `overall: ${overall}  blockers=${result.summary_counts.blockers}  warnings=${result.summary_counts.warnings}\n`,
        );
        for (const [name, section] of Object.entries(result.sections) as [
          string,
          SetupValidationSection,
        ][]) {
          printSection(name, section);
        }
        if ((result as SetupValidationResponse).recommendations.length > 0) {
          process.stdout.write(`\n${pc.bold("RECOMMENDATIONS")}\n`);
          for (const r of (result as SetupValidationResponse).recommendations) {
            process.stdout.write(`  ${pc.cyan("→")} ${r}\n`);
          }
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

export const diagnosticsCommand = defineCommand({
  meta: {
    name: "diagnostics",
    description: "Engine diagnostics: errors, LLM status, setup validation",
  },
  subCommands: {
    errors: errorsCommand,
    llm: llmCommand,
    setup: setupCommand,
  },
});
