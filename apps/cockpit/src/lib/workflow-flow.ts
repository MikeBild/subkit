import { pluralKey, type TranslationKey } from "@/lib/i18n";
import { isAiService, type ServiceIdentity } from "@/lib/service-icons";
import {
  formatDuration,
  type WorkflowStepDefinition,
  workflowStepKindKey,
} from "@/lib/workflow-steps";

export interface Phrase {
  key: TranslationKey;
  values?: Record<string, string | number>;
}

const READ_VERBS = new Set(["GET", "HEAD", "OPTIONS", "LIST"]);

const TRANSFORM_KEYS: Record<string, TranslationKey> = {
  javascript: "workflowFlow.step.code",
  readability: "workflowFlow.step.readability",
  "html-to-markdown": "workflowFlow.step.markdown",
  "structured-data": "workflowFlow.step.structured",
};

export function stepPhrase(
  definition: WorkflowStepDefinition,
  service: string | null,
  identity: ServiceIdentity | null = null,
): Phrase {
  const { essence } = definition;
  const named = service ? { service } : null;
  switch (essence.kind) {
    case "request":
      if (named && identity && isAiService(identity))
        return { key: "workflowFlow.step.asks", values: named };
      if (essence.via === "http") {
        const reads = READ_VERBS.has((essence.verb ?? "GET").toUpperCase());
        if (named)
          return {
            key: reads ? "workflowFlow.step.reads" : "workflowFlow.step.sends",
            values: named,
          };
        return { key: reads ? "workflowFlow.step.readsAny" : "workflowFlow.step.sendsAny" };
      }
      return named
        ? { key: "workflowFlow.step.uses", values: named }
        : { key: "workflowFlow.step.usesAny" };
    case "transform":
      return { key: TRANSFORM_KEYS[essence.language] ?? "workflowFlow.step.transform" };
    case "branch":
      return { key: "workflowFlow.step.branch" };
    case "loop":
      return { key: "workflowFlow.step.loop" };
    case "parallel":
      return { key: "workflowFlow.step.parallel", values: { count: essence.branches.length } };
    case "call":
      return { key: "workflowFlow.step.call" };
    case "wait":
      return essence.durationMs === null
        ? { key: "workflowFlow.step.waitAny" }
        : {
            key: "workflowFlow.step.wait",
            values: { duration: formatDuration(essence.durationMs) },
          };
    case "wait_for_event":
      return { key: "workflowFlow.step.event" };
    default:
      return { key: "workflowFlow.step.other" };
  }
}

export function stepWrites(definition: WorkflowStepDefinition): boolean | null {
  const { essence } = definition;
  if (essence.kind !== "request") return null;
  const declared = definition.raw.side_effects;
  if (declared === "read") return false;
  if (declared === "write") return true;
  if (essence.via !== "http") return null;
  return !READ_VERBS.has((essence.verb ?? "GET").toUpperCase());
}

export function stepKindKey(
  definition: WorkflowStepDefinition,
  service: ServiceIdentity | null,
): TranslationKey {
  const { essence } = definition;
  if (essence.kind === "request" && service && isAiService(service)) return "workflow.kind.askAi";
  if (essence.kind === "request" && stepWrites(definition) === true) return "workflow.kind.send";
  if (essence.kind === "transform" && essence.language === "javascript")
    return "workflow.kind.code";
  return workflowStepKindKey(definition.kind);
}

export function runStepKindKey(
  kind: string,
  effect: "read" | "write" | null,
  service: ServiceIdentity | null,
): TranslationKey {
  if (kind === "request" && service && isAiService(service)) return "workflow.kind.askAi";
  if (kind === "request" && effect === "write") return "workflow.kind.send";
  return workflowStepKindKey(kind);
}

export type TriggerKind = "schedule" | "webhook" | "request";

export function triggerKindOf(value: unknown): TriggerKind {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  return kind === "schedule" || kind === "webhook" ? kind : "request";
}

export function resultPhrase(outputSchema: unknown): Phrase {
  if (!outputSchema || typeof outputSchema !== "object" || Array.isArray(outputSchema))
    return { key: "workflowFlow.result.none" };
  const schema = outputSchema as Record<string, unknown>;
  const title = typeof schema.title === "string" ? schema.title.trim() : "";
  if (title) return { key: "workflowFlow.result.named", values: { what: title } };
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  if (properties.length > 0)
    return {
      key: pluralKey("workflowFlow.result.fields", properties.length),
      values: { count: properties.length },
    };
  if (schema.type === "array") return { key: "workflowFlow.result.list" };
  return { key: "workflowFlow.result.declared" };
}

export interface DatedRun {
  id: string;
  started_at?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export type DayLabel = { kind: "today" } | { kind: "yesterday" } | { kind: "date"; date: Date };

export interface DayGroup<T> {
  key: string;
  label: DayLabel;
  items: T[];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function runStartedAt(run: DatedRun): string {
  return run.started_at ?? run.created_at;
}

export function groupRunsByDay<T extends DatedRun>(runs: readonly T[], now: Date): DayGroup<T>[] {
  const today = dayKey(now);
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  const yesterday = dayKey(before);
  const groups: DayGroup<T>[] = [];
  for (const run of runs) {
    const date = new Date(runStartedAt(run));
    const key = Number.isNaN(date.getTime()) ? "unknown" : dayKey(date);
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = {
        key,
        label:
          key === today
            ? { kind: "today" }
            : key === yesterday
              ? { kind: "yesterday" }
              : { kind: "date", date },
        items: [],
      };
      groups.push(group);
    }
    group.items.push(run);
  }
  return groups;
}

export function successRate(total: number | undefined, failed: number | undefined): number | null {
  if (typeof total !== "number" || typeof failed !== "number" || total === 0) return null;
  return Math.round(((total - Math.min(failed, total)) / total) * 100);
}

export function averageDurationMs(durations: readonly (number | null)[]): number | null {
  const known = durations.filter(
    (value): value is number => typeof value === "number" && value >= 0,
  );
  if (known.length === 0) return null;
  return Math.round(known.reduce((sum, value) => sum + value, 0) / known.length);
}
