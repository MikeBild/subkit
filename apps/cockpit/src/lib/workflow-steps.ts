import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";
import { isAiService, type ServiceIdentity } from "@/lib/service-icons";

export type ExecutionStep = components["schemas"]["ExecutionStep"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type StepEssence =
  | {
      kind: "request";
      via: "http" | "sql" | "graphql" | "s3" | "mcp";
      verb: string | null;
      target: string | null;
    }
  | { kind: "branch"; when: string; thenSteps: string[]; elseSteps: string[] }
  | { kind: "loop"; over: string | null; body: string[] }
  | { kind: "parallel"; branches: string[][] }
  | { kind: "call"; workflowId: string | null; slug: string | null }
  | { kind: "wait"; durationMs: number | null }
  | {
      kind: "wait_for_event";
      event: string | null;
      timeoutMs: number | null;
      onTimeout: string | null;
    }
  | { kind: "transform"; language: string }
  | { kind: "other" };

export type StepFact =
  | { labelKey: TranslationKey; value: string }
  | { labelKey: TranslationKey; valueKey: TranslationKey };

export interface StepBlock {
  labelKey: TranslationKey;
  language: "json" | "javascript" | "sql" | "graphql" | "text";
  code: string;
}

export interface WorkflowStepDefinition {
  id: string;
  kind: string;
  connector: string | null;
  connectorId: string | null;
  essence: StepEssence;
  facts: StepFact[];
  blocks: StepBlock[];
  raw: Record<string, unknown>;
}

export function connectorNameOf(
  definition: WorkflowStepDefinition,
  namesById: ReadonlyMap<string, string>,
): string | null {
  if (definition.connector) return definition.connector;
  if (!definition.connectorId) return null;
  return namesById.get(definition.connectorId) ?? null;
}

export interface WorkflowStepView {
  definition: WorkflowStepDefinition;
  lastRun: ExecutionStep | null;
}

const STEP_KIND_KEYS: Record<string, TranslationKey> = {
  request: "workflow.kind.request",
  transform: "workflow.kind.transform",
  call: "workflow.kind.call",
  wait: "workflow.kind.wait",
  wait_for_event: "workflow.kind.waitForEvent",
  branch: "workflow.kind.branch",
  parallel: "workflow.kind.parallel",
  loop: "workflow.kind.loop",
};

export interface StepKindSource {
  kind: string;
  language?: string | null;
  service?: ServiceIdentity | null;
  writes?: boolean | null;
}

export const READ_VERBS = new Set(["GET", "HEAD", "OPTIONS", "LIST"]);

export function stepWrites(
  definition: Pick<WorkflowStepDefinition, "essence" | "raw">,
): boolean | null {
  const { essence } = definition;
  if (essence.kind !== "request") return null;
  const declared = definition.raw.side_effects;
  if (declared === "read") return false;
  if (declared === "write") return true;
  if (essence.via !== "http") return null;
  return !READ_VERBS.has((essence.verb ?? "GET").toUpperCase());
}

export function stepKindKey(step: StepKindSource): TranslationKey {
  if (step.kind === "request" && step.service && isAiService(step.service))
    return "workflow.kind.askAi";
  if (step.kind === "transform" && step.language === "javascript") return "workflow.kind.code";
  if (step.kind === "request" && step.writes) return "workflow.kind.send";
  return STEP_KIND_KEYS[step.kind] ?? "workflow.stepType";
}

export function definitionKind(
  definition: Pick<WorkflowStepDefinition, "kind" | "essence" | "raw">,
  service: ServiceIdentity | null,
): StepKindSource {
  return {
    kind: definition.kind,
    language: definition.essence.kind === "transform" ? definition.essence.language : null,
    writes: stepWrites(definition),
    service,
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function json(labelKey: TranslationKey, value: unknown): StepBlock[] {
  if (value === undefined || value === null) return [];
  if (record(value) && Object.keys(value).length === 0) return [];
  if (Array.isArray(value) && value.length === 0) return [];
  return [
    {
      labelKey,
      language: typeof value === "string" ? "text" : "json",
      code: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ];
}

function code(
  labelKey: TranslationKey,
  language: StepBlock["language"],
  value: unknown,
): StepBlock[] {
  const source = text(value);
  return source ? [{ labelKey, language, code: source }] : [];
}

const SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api[-_]?key|signature/i;

const REFERENCE = /\$\{[^}]+\}|\{\{[^}]+\}\}/;

export const SECRET_MASK = "•••";

export function isLiteralSecretHeader(name: string, value: string): boolean {
  return SENSITIVE_HEADER.test(name) && !REFERENCE.test(value);
}

function headerLines(value: unknown): string | null {
  if (!record(value)) return null;
  const lines = Object.entries(value).map(([name, entry]) => {
    const shown = typeof entry === "string" ? entry : JSON.stringify(entry);
    return `${name}: ${isLiteralSecretHeader(name, shown) ? SECRET_MASK : shown}`;
  });
  return lines.length > 0 ? lines.join("\n") : null;
}

function readRequest(raw: Record<string, unknown>): {
  essence: StepEssence;
  facts: StepFact[];
  blocks: StepBlock[];
} {
  const method = text(raw.method);
  const facts: StepFact[] = [];
  const blocks: StepBlock[] = [];
  let essence: StepEssence;

  if (record(raw.sql)) {
    const query = text(raw.sql.query) ?? "";
    essence = { kind: "request", via: "sql", verb: method, target: firstLine(query) || null };
    blocks.push(...code("workflow.block.sql", "sql", raw.sql.query));
    blocks.push(...json("workflow.block.sqlParams", raw.sql.params));
    blocks.push(...json("workflow.block.sqlAlso", raw.sql.also));
  } else if (record(raw.graphql)) {
    const query = text(raw.graphql.query) ?? "";
    essence = {
      kind: "request",
      via: "graphql",
      verb: text(raw.graphql.operation),
      target: firstLine(query) || null,
    };
    const path = text(raw.path);
    if (path) blocks.push(...code("workflow.block.request", "text", `POST ${path}`));
    blocks.push(...code("workflow.block.graphql", "graphql", raw.graphql.query));
    blocks.push(...json("workflow.block.variables", raw.graphql.variables));
    blocks.push(...json("workflow.block.pagination", raw.graphql.cursor_pagination));
  } else if (record(raw.mcp)) {
    essence = {
      kind: "request",
      via: "mcp",
      verb: text(raw.mcp.operation) ?? "call_tool",
      target: text(raw.mcp.tool) ?? text(raw.mcp.uri) ?? text(raw.mcp.prompt),
    };
    blocks.push(...json("workflow.block.arguments", raw.mcp.arguments));
  } else if (record(raw.s3)) {
    essence = {
      kind: "request",
      via: "s3",
      verb: method,
      target: text(raw.s3.key) ?? text(raw.s3.prefix),
    };
    blocks.push(...json("workflow.block.storage", raw.s3));
  } else {
    essence = {
      kind: "request",
      via: "http",
      verb: method ?? "GET",
      target: text(raw.path) ?? text(raw.url),
    };
  }

  if (essence.via === "http") {
    blocks.push(
      ...code("workflow.block.request", "text", `${essence.verb} ${essence.target ?? ""}`.trim()),
    );
  }
  blocks.push(...json("workflow.block.query", raw.query));
  const headers = headerLines(raw.headers);
  if (headers) blocks.push({ labelKey: "workflow.block.headers", language: "text", code: headers });
  blocks.push(...json("workflow.block.body", raw.body));
  if (record(raw.xml)) blocks.push(...json("workflow.block.body", raw.xml.body));
  blocks.push(...json("workflow.block.multipart", raw.multipart));
  blocks.push(...json("workflow.block.pagination", raw.pagination));

  const retries = count(raw.max_retries);
  if (retries !== null && retries > 0)
    facts.push({ labelKey: "workflow.fact.retries", value: String(retries) });
  if (raw.side_effects === "read" || raw.side_effects === "write")
    facts.push({
      labelKey: "catalog.sideEffects",
      valueKey: raw.side_effects === "read" ? "sideEffects.read" : "sideEffects.write",
    });
  return { essence, facts, blocks };
}

function readKind(
  kind: string,
  raw: Record<string, unknown>,
): { essence: StepEssence; facts: StepFact[]; blocks: StepBlock[] } {
  switch (kind) {
    case "request":
      return readRequest(raw);
    case "branch":
      return {
        essence: {
          kind: "branch",
          when: text(raw.when) ?? "",
          thenSteps: strings(raw.then_steps),
          elseSteps: strings(raw.else_steps),
        },
        facts: [],
        blocks: code("workflow.block.condition", "text", raw.when),
      };
    case "loop": {
      const over = text(raw.over) ?? text(raw.data_selector);
      return {
        essence: { kind: "loop", over, body: strings(raw.body) },
        facts:
          raw.fail_fast === true
            ? [{ labelKey: "workflow.fact.failFast", valueKey: "common.yes" }]
            : [],
        blocks: code("workflow.block.over", "text", over),
      };
    }
    case "parallel":
      return {
        essence: {
          kind: "parallel",
          branches: Array.isArray(raw.branches) ? raw.branches.map(strings) : [],
        },
        facts: [],
        blocks: [],
      };
    case "call":
      return {
        essence: {
          kind: "call",
          workflowId: text(raw.workflow_id),
          slug: text(raw.workflow_slug),
        },
        facts: [],
        blocks: json("workflow.block.input", raw.input),
      };
    case "wait":
      return {
        essence: { kind: "wait", durationMs: count(raw.duration_ms) },
        facts: [],
        blocks: [],
      };
    case "wait_for_event":
      return {
        essence: {
          kind: "wait_for_event",
          event: text(raw.event_name),
          timeoutMs: count(raw.timeout_ms),
          onTimeout: text(raw.on_timeout),
        },
        facts: [],
        blocks: json("workflow.block.match", raw.match),
      };
    case "transform": {
      const language = text(raw.language) ?? "javascript";
      return {
        essence: { kind: "transform", language },
        facts: [],
        blocks: [
          ...code(
            "workflow.block.expression",
            language === "javascript" ? "javascript" : "text",
            raw.expression,
          ),
          ...json("workflow.block.settings", raw.readability),
          ...json("workflow.block.settings", raw.markdown),
          ...json("workflow.block.settings", raw.structured_data),
        ],
      };
    }
    default:
      return { essence: { kind: "other" }, facts: [], blocks: [] };
  }
}

export function readStepDefinition(step: unknown, index: number): WorkflowStepDefinition {
  const raw = record(step) ? step : {};
  const kind = text(raw.kind) ?? text(raw.type) ?? "";
  const { essence, facts, blocks } = readKind(kind, raw);
  blocks.push(...code("workflow.block.forEach", "javascript", raw.for_each));
  if (kind !== "loop") blocks.push(...code("workflow.block.selector", "text", raw.data_selector));
  const timeout = kind === "wait_for_event" ? null : count(raw.timeout_ms);
  if (timeout !== null)
    facts.push({ labelKey: "workflow.fact.timeout", value: formatDuration(timeout) });
  if (raw.on_error === "continue")
    facts.push({ labelKey: "workflow.fact.onError", valueKey: "workflow.fact.onErrorContinue" });
  return {
    id: text(raw.id) ?? `step-${index + 1}`,
    kind,
    connector: text(raw.connector) ?? text(raw.connector_slug),
    connectorId: text(raw.connector_id),
    essence,
    facts,
    blocks,
    raw,
  };
}

export function stepDefinitionsOf(dag: unknown): ReadonlyMap<string, WorkflowStepDefinition> {
  const steps = record(dag) && Array.isArray(dag.steps) ? dag.steps : [];
  return new Map(
    steps.map((step, index) => {
      const definition = readStepDefinition(step, index);
      return [definition.id, definition] as const;
    }),
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1_000 === 0) return `${ms / 1_000} s`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

const VIA_KEYS: Record<
  Exclude<Extract<StepEssence, { kind: "request" }>["via"], "http">,
  TranslationKey
> = {
  sql: "workflow.via.sql",
  graphql: "workflow.via.graphql",
  s3: "workflow.via.s3",
  mcp: "workflow.via.mcp",
};

export function stepEssenceText(
  definition: WorkflowStepDefinition,
  t: Translate,
  names: { connector: string | null; calledWorkflow?: string | null },
): string {
  const { essence } = definition;
  const list = (ids: readonly string[]) => (ids.length > 0 ? ids.join(", ") : t("workflow.none"));
  const line = (() => {
    switch (essence.kind) {
      case "request": {
        const head =
          essence.via === "http"
            ? [essence.verb, essence.target].filter(Boolean).join(" ")
            : [t(VIA_KEYS[essence.via]), essence.target].filter(Boolean).join(" · ");
        return [head, names.connector].filter(Boolean).join(" · ");
      }
      case "branch":
        return essence.elseSteps.length > 0
          ? t("workflow.essence.branchElse", {
              when: essence.when,
              steps: list(essence.thenSteps),
              otherwise: list(essence.elseSteps),
            })
          : t("workflow.essence.branch", { when: essence.when, steps: list(essence.thenSteps) });
      case "loop":
        return t("workflow.essence.loop", {
          over: essence.over ?? t("workflow.none"),
          body: list(essence.body),
        });
      case "parallel":
        return t("workflow.essence.parallel", {
          branches: essence.branches.map((branch) => list(branch)).join(" ‖ "),
        });
      case "call":
        return t("workflow.essence.call", {
          workflow: names.calledWorkflow ?? essence.slug ?? t("workflow.essence.callUnknown"),
        });
      case "wait":
        return essence.durationMs === null
          ? t("workflow.kind.wait")
          : t("workflow.essence.wait", { duration: formatDuration(essence.durationMs) });
      case "wait_for_event":
        return t("workflow.essence.waitForEvent", {
          event: essence.event ?? t("workflow.none"),
          timeout: essence.timeoutMs === null ? "—" : formatDuration(essence.timeoutMs),
        });
      case "transform":
        return TRANSFORM_LANGUAGES[essence.language] ?? essence.language;
      default:
        return "";
    }
  })();
  return maskIdentifiers(line);
}

const TRANSFORM_LANGUAGES: Record<string, string> = {
  javascript: "JavaScript",
  readability: "Readability",
  "html-to-markdown": "HTML → Markdown",
  "structured-data": "Structured Data",
};

export function joinStepsWithLastRun(
  steps: readonly unknown[],
  runSteps: readonly ExecutionStep[],
): WorkflowStepView[] {
  const byKey = new Map<string, ExecutionStep>();
  for (const runStep of runSteps) {
    const existing = byKey.get(runStep.step_key);
    if (!existing || (runStep.step_index ?? 0) >= (existing.step_index ?? 0))
      byKey.set(runStep.step_key, runStep);
  }
  return steps.map((step, index) => {
    const definition = readStepDefinition(step, index);
    return { definition, lastRun: byKey.get(definition.id) ?? null };
  });
}

export function stepResultPreview(step: ExecutionStep | null): string | null {
  if (!step) return null;
  return render(step.error) ?? render(step.output_preview) ?? render(step.result_preview);
}

function render(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function maskIdentifiers(value: string): string {
  return value.replace(UUID, "…");
}

export interface BuildWorkflow {
  current_version_id: string | null;
  current_version: number | null;
  draft_version_id: string | null;
  steps: readonly unknown[];
  definition?: Record<string, unknown> | null;
}

export interface SavedDraft {
  version_id: string;
  version: number;
  definition: Record<string, unknown> & { steps: readonly unknown[] };
}

export interface BuildVersion {
  steps: readonly unknown[];
  definition: Record<string, unknown> | null;
  versionId: string | null;
  version: number | null;
  saved: boolean;
  pending: boolean;
}

export function buildVersion(
  workflow: BuildWorkflow,
  draft: { data: SavedDraft | undefined; settled: boolean },
): BuildVersion {
  const active: BuildVersion = {
    steps: workflow.steps,
    definition: workflow.definition ?? null,
    versionId: workflow.current_version_id,
    version: workflow.current_version,
    saved: false,
    pending: false,
  };
  const waiting =
    workflow.draft_version_id !== null && workflow.draft_version_id !== workflow.current_version_id
      ? workflow.draft_version_id
      : null;
  if (!waiting) return active;
  const loaded = draft.data?.version_id === waiting ? draft.data : null;
  if (loaded)
    return {
      steps: loaded.definition.steps,
      definition: loaded.definition,
      versionId: loaded.version_id,
      version: loaded.version,
      saved: true,
      pending: false,
    };
  return draft.settled ? active : { ...active, steps: [], pending: true };
}

interface PreviewRunStep {
  step_key: string;
  status?: string;
  held?: boolean;
}

export interface PreviewSummary {
  status: string;
  ran: number;
  total: number;
  held: number;
  stoppedAt: string | null;
  output: unknown;
  error: string | null;
}

export function previewSummary(result: Record<string, unknown>, total: number): PreviewSummary {
  const steps = Array.isArray(result.steps)
    ? result.steps.filter(
        (step): step is PreviewRunStep =>
          Boolean(step) &&
          typeof step === "object" &&
          typeof (step as { step_key?: unknown }).step_key === "string",
      )
    : [];
  const status = typeof result.status === "string" ? result.status : "failed";
  const failed = steps.find((step) => step.status === "failed");
  const error =
    result.error && typeof result.error === "object"
      ? (result.error as { message?: unknown }).message
      : result.error;
  return {
    status,
    ran: steps.length,
    total: Math.max(total, steps.length),
    held: steps.filter((step) => step.held === true).length,
    stoppedAt: status === "succeeded" ? null : (failed?.step_key ?? null),
    output: result.output,
    error: typeof error === "string" && error ? error : null,
  };
}
