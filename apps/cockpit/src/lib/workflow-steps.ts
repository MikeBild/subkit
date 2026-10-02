import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type ExecutionStep = components["schemas"]["ExecutionStep"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * What a step does, in the parts a sentence is built from. One shape per step
 * kind of the engine's schema (`apps/engine/src/workflows/types.ts`); a kind
 * this build does not know is `other` and says only its name.
 */
export type StepEssence =
  | {
      kind: "request";
      /** How the request travels: plain HTTP, or one of the driver variants. */
      via: "http" | "sql" | "graphql" | "s3" | "mcp";
      /** HTTP method, SQL verb or MCP operation. */
      verb: string | null;
      /** Path, URL, first statement line, object key or tool name. */
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

/**
 * A short fact of the step's configuration, shown as label and value. A value
 * the engine spells as an enum word carries the catalogue key for it instead.
 */
export type StepFact =
  | { labelKey: TranslationKey; value: string }
  | { labelKey: TranslationKey; valueKey: TranslationKey };

/**
 * A piece of configuration shown in a fenced block — a body, a query, an
 * expression. It is PAYLOAD: rendered byte for byte, never rewritten. An
 * identifier in it is content the reader may have to copy.
 */
export interface StepBlock {
  labelKey: TranslationKey;
  language: "json" | "javascript" | "sql" | "graphql" | "text";
  code: string;
}

export interface WorkflowStepDefinition {
  id: string;
  kind: string;
  /** Connector slug when the step names one. */
  connector: string | null;
  /** Connector reference, resolved to a name before display — never rendered raw. */
  connectorId: string | null;
  essence: StepEssence;
  facts: StepFact[];
  blocks: StepBlock[];
  raw: Record<string, unknown>;
}

/** The connector a step uses, as a name. Returns null rather than an id. */
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
  /** The same step in the most recent run, when it ran at all. */
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
  tool: "workflow.kind.tool",
};

/** Names an engine step kind for people; an unknown enum never leaks into UI. */
export function workflowStepKindKey(kind: string): TranslationKey {
  return STEP_KIND_KEYS[kind] ?? "workflow.stepType";
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

/** The first line that says something, so a statement fits one row. */
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

/** A header whose value is a credential, by its name. */
const SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api[-_]?key|signature/i;

/** A reference the engine resolves at run time: `${…}` or `{{…}}`. */
const REFERENCE = /\$\{[^}]+\}|\{\{[^}]+\}\}/;

/**
 * A request's headers as name and value, as the step declares them.
 *
 * A definition holds references — `Bearer {{credentials.token}}`,
 * `${input.id}` — and a reference is the configuration, not a secret: it is
 * shown and copied byte for byte, like everything else in a fenced block. The
 * one exception is a LITERAL value under a credential-shaped name, with no
 * reference in it. That is a secret someone pasted into a definition, where it
 * does not belong; the page is read over a shoulder, so it stays masked.
 */
function headerLines(value: unknown): string | null {
  if (!record(value)) return null;
  const lines = Object.entries(value).map(([name, entry]) => {
    const shown = typeof entry === "string" ? entry : JSON.stringify(entry);
    const literalSecret = SENSITIVE_HEADER.test(name) && !REFERENCE.test(shown);
    return `${name}: ${literalSecret ? "•••" : shown}`;
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
    blocks.push(...code("workflow.block.graphql", "graphql", raw.graphql.query));
    blocks.push(...json("workflow.block.variables", raw.graphql.variables));
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

  // The request line and everything sent with it. The address is payload too:
  // it stands in a fenced block, exactly as the step declares it.
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

/**
 * Reads a step's configuration per kind, against the engine's step schema.
 * Nothing here rewrites a value: facts and blocks carry what the definition
 * says, and the block renderer shows it unaltered.
 */
export function readStepDefinition(step: unknown, index: number): WorkflowStepDefinition {
  const raw = record(step) ? step : {};
  const kind = text(raw.kind) ?? text(raw.type) ?? "";
  const { essence, facts, blocks } = readKind(kind, raw);
  // What every kind may carry.
  blocks.push(...code("workflow.block.forEach", "javascript", raw.for_each));
  if (kind !== "loop") blocks.push(...code("workflow.block.selector", "text", raw.data_selector));
  // A wait-for-event names its own limit in its sentence; elsewhere it is a fact.
  const timeout = kind === "wait_for_event" ? null : count(raw.timeout_ms);
  if (timeout !== null)
    facts.push({ labelKey: "workflow.fact.timeout", value: formatDuration(timeout) });
  // `fail` is the default and says nothing; continuing past an error does.
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

/** A duration in the largest unit that keeps it a whole number: 90 s, 5 min, 2 h. */
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

/**
 * One line that says what the step does — "GET /users · Example API",
 * "if status = 200 → shape_success, else shape_failure". It stands outside a
 * fenced block, so an identifier inside it is masked like any other on the
 * page; the unaltered value is in the step's blocks.
 */
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

/**
 * Joins the saved definition with the most recent run by step id — the
 * execution rows carry it as `step_key`. A step that never ran keeps a null
 * result rather than borrowing another step's.
 */
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

/**
 * What a step's last run produced, preferring the structured value. Shown in a
 * fenced block, so it is the run's own output, unaltered.
 */
export function stepResultPreview(step: ExecutionStep | null): string | null {
  if (!step) return null;
  return render(step.error) ?? render(step.output_preview) ?? render(step.result_preview);
}

function render(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Replaces identifiers in a line that stands OUTSIDE a fenced block, where a
 * UUID is a label nobody reads. Never applied to a block: there it is payload.
 */
export function maskIdentifiers(value: string): string {
  return value.replace(UUID, "…");
}
