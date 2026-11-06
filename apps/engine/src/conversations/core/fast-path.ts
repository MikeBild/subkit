import {
  type CatalogKind,
  categoryListLanguage,
  matchCategoryListIntent,
  matchListIntent,
  matchMultiCatalog,
} from "../fast-path/intents.ts";
import type { ReplyLanguage } from "../fast-path-lists.ts";
import { renderRunOutput } from "../fast-path-render.ts";
import { AFFIRM_RE, INSPECT_EXEC_RE, RUN_VERB_RE } from "../intent-patterns.ts";

export type FastPathRoute =
  | { kind: "list"; list: CatalogKind }
  | { kind: "category"; category: string; language: ReplyLanguage }
  | { kind: "catalogs"; lists: CatalogKind[] }
  | { kind: "inspect"; execution_id: string }
  | { kind: "run"; slug_or_id: string }
  | { kind: "affirm" };

export function decideTurn(userMessage: string): FastPathRoute[] {
  const text = userMessage.trim();
  const list = matchListIntent(text);
  if (list) return [{ kind: "list", list }];
  const category = matchCategoryListIntent(text);
  const leading: FastPathRoute[] = category
    ? [{ kind: "category", category, language: categoryListLanguage(text) }]
    : [];
  const terminal = terminalRoute(text);
  return terminal ? [...leading, terminal] : leading;
}

function terminalRoute(text: string): FastPathRoute | null {
  const lists = matchMultiCatalog(text);
  if (lists) return { kind: "catalogs", lists };
  const execution_id = text.match(INSPECT_EXEC_RE)?.[2];
  if (execution_id) return { kind: "inspect", execution_id };
  const slug_or_id = text.match(RUN_VERB_RE)?.[2];
  if (slug_or_id) return { kind: "run", slug_or_id };
  return AFFIRM_RE.test(text) ? { kind: "affirm" } : null;
}

export function listToolFor(kind: CatalogKind): string {
  return `list_${kind}`;
}

export const READ_PERMISSION_BY_LIST: Record<CatalogKind, string> = {
  workflows: "workflow:read",
  connectors: "connector:read",
  executions: "execution:read",
  schedules: "schedule:read",
  knowledge_sources: "knowledge:read",
};

export type GateSurface = "mcp" | "chat";

export function gateSurfaceFor(surface: string | undefined): GateSurface {
  return surface === "mcp" ? "mcp" : "chat";
}

export type RunEnvironment = "dev" | "prod";

export type EnvironmentResolution =
  | { kind: "resolved"; environment: RunEnvironment }
  | { kind: "default"; dev_bindings: readonly (RunEnvironment | null)[] }
  | { kind: "ambiguous" };

export const FAST_PATH_DEFAULT_ENVIRONMENT: RunEnvironment = "dev";

export function decideRunEnvironment(resolution: EnvironmentResolution): RunEnvironment | null {
  if (resolution.kind === "ambiguous") return null;
  if (resolution.kind === "resolved") return resolution.environment;
  return resolution.dev_bindings.every((bound) => bound === FAST_PATH_DEFAULT_ENVIRONMENT)
    ? FAST_PATH_DEFAULT_ENVIRONMENT
    : null;
}

export const AFFIRM_RESUME_WINDOW_MS = 5 * 60 * 1000;

export interface RecentRunCall {
  output: unknown;
  confirmation_data: unknown;
  created_at: Date | null;
}

export function resumableApprovalId(head: RecentRunCall | undefined, now: number): string | null {
  if (!head) return null;
  const output = head.output as { pending?: unknown } | null;
  const confirmation = head.confirmation_data as { approval_id?: unknown } | null;
  const approvalId =
    typeof confirmation?.approval_id === "string" ? confirmation.approval_id : null;
  if (output?.pending !== true) return null;
  return now - (head.created_at?.getTime() ?? 0) < AFFIRM_RESUME_WINDOW_MS ? approvalId : null;
}

export type ReplayRefusal =
  | { reason: "approval_environment_missing"; reply: string }
  | { reason: "workflow_not_found"; reply: string };

export function replayRefusal(workflowAvailable: boolean, slug: string | null): ReplayRefusal {
  return workflowAvailable
    ? {
        reason: "approval_environment_missing",
        reply:
          "The confirmation names no environment; nothing was run. Ask again to obtain a fresh confirmation.",
      }
    : {
        reason: "workflow_not_found",
        reply: `The workflow ${slug ?? "(unknown)"} is no longer available; nothing was run.`,
      };
}

export interface StepLine {
  step_key: string;
  kind: string;
  status: string;
  duration_ms: number | null;
}

export function stepLine(step: StepLine): string {
  return `- ${step.step_key} (${step.kind}) ${step.status}${step.duration_ms != null ? ` · ${step.duration_ms}ms` : ""}`;
}

export interface RunSummary {
  status: string;
  output: unknown;
  steps: readonly StepLine[];
  warnings?: ReadonlyArray<{ code: string }>;
}

export interface RunReply {
  ok: boolean;
  held_preview: boolean;
  reply: string;
}

const GERMAN_RUN_RE = /^(?:starte|f[uü]hre|ja|jo|los|bestätigt)\b/i;

export function runReply(
  slug: string,
  userMessage: string,
  run: RunSummary,
  heldPreviewCode: string,
): RunReply {
  const warnings = run.warnings ?? [];
  const held_preview = warnings.some((warning) => warning.code === heldPreviewCode);
  const ok = run.status === "succeeded" && !held_preview;
  const warningLine =
    warnings.length > 0
      ? `${warnings.length} warning(s): ${Array.from(new Set(warnings.map((w) => w.code)))
          .sort()
          .join(", ")}`
      : null;
  if (held_preview) {
    const reply = GERMAN_RUN_RE.test(userMessage.trim())
      ? `Vorschau für ${slug}: Es wurde nichts geschrieben. Prüfe vor einem Live-Lauf die Ausführungsfreigabe des Workflows.`
      : `Preview of ${slug}: Nothing was written. Review the workflow's execution authority before a live run.`;
    return { ok, held_preview, reply };
  }
  if (ok) {
    const rendered = renderRunOutput(run.output) ?? `Ran ${slug}: succeeded`;
    return { ok, held_preview, reply: warningLine ? `${rendered}\n\n${warningLine}` : rendered };
  }
  const parts = [`Ran ${slug}: ${run.status}`, ...run.steps.map(stepLine)];
  if (warningLine) parts.push(warningLine);
  return { ok, held_preview, reply: parts.join("\n") };
}

export function runNextActions(status: string): string[] {
  return status === "succeeded"
    ? ["inspect_execution_step", "run_workflow"]
    : ["diagnose_latest_execution", "inspect_workflow"];
}
