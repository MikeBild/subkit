import { basename } from "node:path";
import pc from "picocolors";
import { STATUS_GLYPH } from "../repl/plan-cell.tsx";
import { type AnyIntent, humanBytes } from "./intent-card.tsx";
import type { AnySummary } from "./summary-card.tsx";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceIntent,
  KnowledgeSourceSummary,
  Phase,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "./types.ts";

export type { AnyIntent } from "./intent-card.tsx";
export type { AnySummary } from "./summary-card.tsx";

export interface RenderOptions {
  jsonMode?: boolean;
}

function ttyAllowed(opts: RenderOptions): boolean {
  if (opts.jsonMode) return false;
  return Boolean(process.stderr.isTTY);
}

async function mountInk(node: import("react").ReactElement): Promise<void> {
  const { render } = await import("ink");
  const instance = render(node, { stdout: process.stderr });
  await instance.waitUntilExit();
  instance.unmount();
}

function triggerLine(trigger: WorkflowTrigger): string {
  if (trigger.kind === "schedule") return `schedule cron=${trigger.cron} tz=${trigger.tz}`;
  if (trigger.kind === "webhook") {
    const evs = trigger.events.length > 0 ? trigger.events.join(",") : "*";
    return `webhook source=${trigger.source} events=${evs}`;
  }
  return "request";
}

function isWorkflowIntent(i: AnyIntent): i is WorkflowIntent {
  return Array.isArray((i as WorkflowIntent).steps);
}
function isKnowledgeSourceIntent(i: AnyIntent): i is KnowledgeSourceIntent {
  return typeof (i as KnowledgeSourceIntent).file_path === "string";
}
function isConnectorIntent(i: AnyIntent): i is ConnectorIntent {
  return typeof (i as ConnectorIntent).template_slug === "string";
}

function isWorkflowSummary(s: AnySummary): s is WorkflowSummary {
  return typeof (s as WorkflowSummary).version === "number";
}
function isKnowledgeSourceSummary(s: AnySummary): s is KnowledgeSourceSummary {
  return typeof (s as KnowledgeSourceSummary).mime_type === "string";
}
function isConnectorSummary(s: AnySummary): s is ConnectorSummary {
  return typeof (s as ConnectorSummary).template_slug === "string";
}

function plainIntent(intent: AnyIntent): string {
  const out: string[] = [];
  if (isWorkflowIntent(intent)) {
    const heading = intent.slug ? `${intent.name} (${intent.slug})` : intent.name;
    out.push(`${pc.cyan(pc.bold("●"))} ${pc.bold(`Create workflow ${heading}`)}`);
    out.push(`  ${pc.dim(`trigger: ${triggerLine(intent.trigger)}`)}`);
    for (const s of intent.steps) {
      const tail = s.connector_slug ? ` → ${s.connector_slug}` : "";
      out.push(`  ${pc.dim(`${STATUS_GLYPH.pending} ${s.key} · ${s.kind}${tail}`)}`);
    }
  } else if (isKnowledgeSourceIntent(intent)) {
    out.push(`${pc.cyan(pc.bold("●"))} ${pc.bold(`Create knowledge source ${intent.title}`)}`);
    out.push(`  ${pc.dim(`File: ${basename(intent.file_path)}`)}`);
    out.push(`  ${pc.dim(`Size: ${humanBytes(intent.size_bytes)}`)}`);
    out.push(`  ${pc.dim(`MIME: ${intent.mime_type}`)}`);
  } else if (isConnectorIntent(intent)) {
    const heading = intent.name ? `${intent.name} (${intent.template_slug})` : intent.template_slug;
    out.push(`${pc.cyan(pc.bold("●"))} ${pc.bold(`Create connector ${heading}`)}`);
    out.push(`  ${pc.dim(`Template: ${intent.template_slug}`)}`);
    if (intent.environment) out.push(`  ${pc.dim(`Environment: ${intent.environment}`)}`);
    if (intent.auth_type) out.push(`  ${pc.dim(`Auth: ${intent.auth_type}`)}`);
    if (intent.base_url) out.push(`  ${pc.dim(`Base URL: ${intent.base_url}`)}`);
  }
  return `${out.join("\n")}\n`;
}

function plainSummary(summary: AnySummary): string {
  const out: string[] = [];
  if (isWorkflowSummary(summary)) {
    out.push(
      `${pc.green(pc.bold("✓"))} ${pc.bold(
        `Created workflow "${summary.name}" · id=${summary.id} · version=${summary.version}`,
      )}`,
    );
    out.push(`  ${pc.dim(`trigger: ${triggerLine(summary.trigger)}`)}`);
    if (summary.preview_execution_id) {
      out.push(`  ${pc.dim(`preview execution: ${summary.preview_execution_id}`)}`);
    }
    out.push("");
    out.push(pc.dim("Next:"));
    out.push(`  ${pc.dim(`sk workflows run ${summary.id}`)}`);
    out.push(`  ${pc.dim(`sk workflows get ${summary.id}`)}`);
    out.push(`  ${pc.dim(`sk workflows history ${summary.id}`)}`);
  } else if (isKnowledgeSourceSummary(summary)) {
    out.push(
      `${pc.green(pc.bold("✓"))} ${pc.bold(
        `Created knowledge source "${summary.name}" · id=${summary.id}`,
      )}`,
    );
    out.push(
      `  ${pc.dim(
        `${summary.mime_type} · ${humanBytes(summary.size_bytes)}${
          summary.file_id ? ` · file=${summary.file_id}` : ""
        }`,
      )}`,
    );
    if (summary.link_failed) {
      out.push(`  ${pc.yellow("warning: file link did not persist (best-effort)")}`);
    }
    out.push("");
    out.push(pc.dim("Next:"));
    out.push(`  ${pc.dim(`sk knowledge-sources get ${summary.id}`)}`);
    out.push(`  ${pc.dim(`sk knowledge-sources search <query>`)}`);
  } else if (isConnectorSummary(summary)) {
    out.push(
      `${pc.green(pc.bold("✓"))} ${pc.bold(
        `Created connector "${summary.slug}" · id=${summary.id} · template=${summary.template_slug}`,
      )}`,
    );
    if (summary.probe) {
      const status =
        typeof summary.probe.status_code === "number"
          ? ` · status=${summary.probe.status_code}`
          : "";
      const dur =
        typeof summary.probe.duration_ms === "number" ? ` · ${summary.probe.duration_ms}ms` : "";
      out.push(`  ${pc.dim(`probe: ${summary.probe.ok ? "ok" : "FAILED"}${status}${dur}`)}`);
    }
    out.push("");
    out.push(pc.dim("Next:"));
    out.push(`  ${pc.dim(`sk connectors get ${summary.id}`)}`);
    out.push(`  ${pc.dim(`sk connectors probe ${summary.id}`)}`);
    out.push(`  ${pc.dim(`sk connectors docs-ingest ${summary.id} --url <docs-url>`)}`);
  }
  return `${out.join("\n")}\n`;
}

function plainTaskList(phases: ReadonlyArray<Phase>): string {
  const out: string[] = ["─────────────────────────────"];
  for (const p of phases) {
    const glyph = STATUS_GLYPH[p.status];
    const color =
      p.status === "failed"
        ? pc.red
        : p.status === "succeeded"
          ? pc.green
          : p.status === "running" || p.status === "in_progress"
            ? pc.cyan
            : p.status === "warning"
              ? pc.yellow
              : pc.dim;
    const tail = p.detail ? pc.dim(` · ${p.detail}`) : "";
    out.push(`${color(glyph)} ${p.name}${tail}`);
  }
  return `${out.join("\n")}\n`;
}

export async function renderIntent(intent: AnyIntent, opts: RenderOptions = {}): Promise<void> {
  if (opts.jsonMode) return;
  if (ttyAllowed(opts)) {
    const { IntentCard } = await import("./intent-card.tsx");
    const React = await import("react");
    await mountInk(React.createElement(IntentCard, { intent }));
    return;
  }
  process.stderr.write(plainIntent(intent));
}

export async function renderSummary(summary: AnySummary, opts: RenderOptions = {}): Promise<void> {
  if (opts.jsonMode) return;
  if (ttyAllowed(opts)) {
    const { SummaryCard } = await import("./summary-card.tsx");
    const React = await import("react");
    await mountInk(React.createElement(SummaryCard, { summary }));
    return;
  }
  process.stderr.write(plainSummary(summary));
}

export async function renderTaskFailure(
  phases: ReadonlyArray<Phase>,
  opts: RenderOptions = {},
): Promise<void> {
  if (opts.jsonMode) return;
  if (ttyAllowed(opts)) {
    const { TaskList } = await import("./task-list.tsx");
    const React = await import("react");
    await mountInk(React.createElement(TaskList, { phases }));
    return;
  }
  process.stderr.write(plainTaskList(phases));
}
