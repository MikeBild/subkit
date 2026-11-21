import type { components } from "@cli-core/engine-api/openapi";
import { cronWords } from "@/lib/cron-words";
import type { TranslationKey } from "@/lib/i18n";

export type TaskGrantPreview = components["schemas"]["TaskAuthorityPreview"];
export type TaskGrantResult = components["schemas"]["TaskAuthorityGrantResult"];
export type TaskGrantRecord = components["schemas"]["TaskGrant"];
export type TaskGrantInput = components["schemas"]["TaskAuthorityGrantInput"];
export type TaskGrantBlockReason = NonNullable<TaskGrantResult["workflows"][number]["reason"]>;
type Manifest = components["schemas"]["WorkflowEffectManifest"];
type Effect = Manifest["effects"][number];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type TaskGrantWorkflow = TaskGrantPreview["workflows"][number];

export type WorkflowStanding = "included" | "covered" | "co_granted" | "asks" | "unavailable";
export type EffectWord = "read" | "write" | "delete" | "unknown";

export interface ConnectorRow {
  kind: "connector";
  key: string;
  verb: "read" | "write" | "use";
  name: string | null;
  connectorId: string | null;
}

export interface WebRow {
  kind: "web";
  key: string;
  verb: "read";
}

export interface WorkflowRow {
  kind: "workflow";
  key: string;
  verb: "start";
  workflowId: string;
  versionId: string | null;
  name: string | null;
  standing: WorkflowStanding;
  reason: TaskGrantBlockReason | null;
  summary: Array<{ word: EffectWord; name: string }>;
  manifest: Manifest | null;
  approval: { validUntil: string | null; remainingRuns: number | null } | null;
}

export type TaskGrantRow = ConnectorRow | WebRow | WorkflowRow;

const ASKING: ReadonlySet<TaskGrantBlockReason> = new Set([
  "workflow_not_repeatable",
  "workflow_permission_missing",
]);

const WORD_ORDER: Record<EffectWord, number> = { delete: 0, unknown: 1, write: 2, read: 3 };
const VERB_ORDER: Record<TaskGrantRow["verb"], number> = { read: 0, write: 1, use: 2, start: 3 };

export function previewWorkflows(preview: TaskGrantPreview): TaskGrantWorkflow[] {
  return preview.workflows;
}

export function blockReasonOf(workflow: TaskGrantWorkflow): TaskGrantBlockReason | null {
  if (workflow.blocked_reason) return workflow.blocked_reason;
  if (workflow.covering_authority) return null;
  return workflow.may_grant ? null : "workflow_permission_missing";
}

export function standingOfReason(reason: TaskGrantBlockReason): "asks" | "unavailable" {
  return ASKING.has(reason) ? "asks" : "unavailable";
}

export function workflowStanding(
  workflow: TaskGrantWorkflow,
  grantedAuthorityIds: ReadonlySet<string>,
): WorkflowStanding {
  const reason = blockReasonOf(workflow);
  if (reason) return standingOfReason(reason);
  if (workflow.covering_authority)
    return grantedAuthorityIds.has(workflow.covering_authority.id) ? "co_granted" : "covered";
  return "included";
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

const wordOf = (effect: Effect["effect"]): EffectWord =>
  effect === "read"
    ? "read"
    : effect === "write"
      ? "write"
      : effect === "destructive"
        ? "delete"
        : "unknown";

export function effectSummary(
  manifest: Manifest | null,
  connectorNames: ReadonlyMap<string, string>,
  fallbackName: string,
): Array<{ word: EffectWord; name: string }> {
  const strongest = new Map<string, EffectWord>();
  for (const effect of manifest?.effects ?? []) {
    const name =
      (effect.connector_id ? connectorNames.get(effect.connector_id) : undefined) ??
      hostOf(effect.boundary?.origin ?? effect.target) ??
      fallbackName;
    const word = wordOf(effect.effect);
    const known = strongest.get(name);
    if (known === undefined || WORD_ORDER[word] < WORD_ORDER[known]) strongest.set(name, word);
  }
  return [...strongest.entries()]
    .map(([name, word]) => ({ word, name }))
    .sort(
      (left, right) =>
        WORD_ORDER[right.word] - WORD_ORDER[left.word] || left.name.localeCompare(right.name),
    );
}

export function taskGrantRows(
  preview: TaskGrantPreview,
  connectorNames: ReadonlyMap<string, string>,
  fallbackName: string,
): TaskGrantRow[] {
  const granted = new Set(preview.live_grant?.workflow_authority_ids ?? []);
  const connectors = preview.connectors.map(
    (connector, index): ConnectorRow => ({
      kind: "connector",
      key: `connector:${index}`,
      verb:
        connector.access === "read-only"
          ? "read"
          : connector.access === "read-write"
            ? "write"
            : "use",
      name: connector.name,
      connectorId: connector.name === null ? null : connector.connector_id,
    }),
  );
  const web: WebRow[] = preview.web_search ? [{ kind: "web", key: "web", verb: "read" }] : [];
  const workflows = previewWorkflows(preview).map(
    (workflow, index): WorkflowRow => ({
      kind: "workflow",
      key: `workflow:${index}`,
      verb: "start",
      workflowId: workflow.workflow_id,
      versionId: workflow.workflow_version_id,
      name: workflow.name,
      standing: workflowStanding(workflow, granted),
      reason: blockReasonOf(workflow),
      summary: effectSummary(workflow.effect_manifest, connectorNames, fallbackName),
      manifest: workflow.effect_manifest,
      approval: workflow.covering_authority
        ? {
            validUntil: workflow.covering_authority.valid_until,
            remainingRuns: workflow.covering_authority.remaining_runs,
          }
        : null,
    }),
  );
  return [...connectors, ...web, ...workflows].sort(
    (left, right) => VERB_ORDER[left.verb] - VERB_ORDER[right.verb],
  );
}

export function blockedRows(rows: readonly TaskGrantRow[]): WorkflowRow[] {
  return rows.filter(
    (row): row is WorkflowRow =>
      row.kind === "workflow" && (row.standing === "asks" || row.standing === "unavailable"),
  );
}

export type BlockedNotice =
  | { key: "taskGrant.blocked.asks.one" | "taskGrant.blocked.unavailable.one"; name: string | null }
  | {
      key:
        | "taskGrant.blocked.asks.other"
        | "taskGrant.blocked.unavailable.other"
        | "taskGrant.blocked.mixed";
      count: number;
    };

export function blockedNotice(
  blocked: readonly Pick<WorkflowRow, "name" | "standing">[],
): BlockedNotice | null {
  const [first] = blocked;
  if (!first) return null;
  const asks = blocked.filter((row) => row.standing === "asks").length;
  if (blocked.length === 1)
    return {
      key: asks === 1 ? "taskGrant.blocked.asks.one" : "taskGrant.blocked.unavailable.one",
      name: first.name,
    };
  return {
    key:
      asks === blocked.length
        ? "taskGrant.blocked.asks.other"
        : asks === 0
          ? "taskGrant.blocked.unavailable.other"
          : "taskGrant.blocked.mixed",
    count: blocked.length,
  };
}

export function taskScheduleLine(
  schedule: TaskGrantPreview["schedule"],
  t: Translate,
  localeTag: string,
  dateTime: (value: string) => string,
): string {
  if (schedule.schedule_cron) {
    const rhythm = cronWords(schedule.schedule_cron, t, localeTag);
    return rhythm === schedule.schedule_cron.trim()
      ? t("taskGrant.schedule.own")
      : t("taskGrant.schedule.cron", { rhythm });
  }
  if (schedule.schedule_run_at)
    return t("taskGrant.schedule.once", { date: dateTime(schedule.schedule_run_at) });
  return t("taskGrant.schedule.manual");
}

export function taskGrantInput(
  preview: TaskGrantPreview,
  bounds: { validUntil: string | null; maxRuns: number | null },
): TaskGrantInput {
  const digests: Record<string, string> = {};
  for (const workflow of previewWorkflows(preview))
    if (workflow.effect_manifest_digest && workflowStanding(workflow, new Set()) === "included")
      digests[workflow.workflow_id] = workflow.effect_manifest_digest;
  return {
    expected_fingerprint: preview.fingerprint,
    valid_until: bounds.validUntil,
    max_runs: bounds.maxRuns,
    expected_workflow_digests: digests,
  };
}

export type GrantValidity =
  | { state: "none" }
  | { state: "live"; until: string | null; remainingRuns: number | null }
  | { state: "expired"; until: string }
  | { state: "exhausted" };

export function grantValidity(
  grant: TaskGrantRecord | null | undefined,
  now: number,
): GrantValidity {
  if (!grant || grant.revoked_at !== null) return { state: "none" };
  if (grant.valid_until !== null && Date.parse(grant.valid_until) <= now)
    return { state: "expired", until: grant.valid_until };
  const remainingRuns =
    grant.max_runs === null ? null : Math.max(0, grant.max_runs - grant.reserved_runs);
  if (remainingRuns === 0) return { state: "exhausted" };
  return { state: "live", until: grant.valid_until, remainingRuns };
}

export interface GrantOutcomeRow {
  key: string;
  workflowId: string;
  name: string | null;
  standing: "co_granted" | "covered" | "asks" | "unavailable";
  reason: TaskGrantBlockReason | null;
  versionId: string | null;
}

export function grantOutcome(
  result: TaskGrantResult,
  preview: TaskGrantPreview,
): { rows: GrantOutcomeRow[]; refused: GrantOutcomeRow[]; unexpected: number } {
  const known = new Map(
    previewWorkflows(preview).map((workflow) => [workflow.workflow_id, workflow]),
  );
  const rows = result.workflows.map((workflow, index): GrantOutcomeRow => {
    const seen = known.get(workflow.workflow_id);
    const reason = workflow.outcome === "not_granted" ? workflow.reason : null;
    return {
      key: `outcome:${index}`,
      workflowId: workflow.workflow_id,
      name: seen?.name ?? null,
      standing:
        workflow.outcome === "granted"
          ? "co_granted"
          : workflow.outcome === "covered"
            ? "covered"
            : reason
              ? standingOfReason(reason)
              : "asks",
      reason,
      versionId: seen?.workflow_version_id ?? null,
    };
  });
  const announced = (workflowId: string) => {
    const seen = known.get(workflowId);
    return seen !== undefined && blockReasonOf(seen) !== null;
  };
  const refused = rows.filter((row) => row.standing === "asks" || row.standing === "unavailable");
  return {
    rows,
    refused,
    unexpected: refused.filter((row) => !announced(row.workflowId)).length,
  };
}
