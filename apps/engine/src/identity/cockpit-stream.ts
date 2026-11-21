import { and, eq, inArray, notInArray, or, type SQL, sql } from "drizzle-orm";
import { events, tasks } from "../db/schema/index.ts";
import {
  type OutboxChannel,
  RESOURCE_CHANGE_TYPES,
  type ResourceChangeType,
} from "../pubsub/index.ts";

interface StreamFamily {
  permission: string;
  channel: OutboxChannel;
  types?: readonly string[];
  owner_scoped?: "task";
}

export interface CockpitStreamViewer {
  task_owner_id: string | null;
}

const RESOURCE_TYPES_BY_PERMISSION = {
  workflow: RESOURCE_CHANGE_TYPES.filter((type) => type.startsWith("workflow.authority_")),
  schedule: RESOURCE_CHANGE_TYPES.filter((type) => type === "workflow.automation_changed"),
  connector: RESOURCE_CHANGE_TYPES.filter((type) => type.startsWith("connector.")),
  task: RESOURCE_CHANGE_TYPES.filter(
    (type) => type.startsWith("task.") || type.startsWith("task_run."),
  ),
};

const LIST_CHANGE_FAMILIES = [
  { permission: "knowledge:read", type: "knowledge_source.changed" },
  { permission: "file:read", type: "file.changed" },
  { permission: "identity:read", type: "identity.changed" },
  { permission: "rbac:read", type: "rbac.changed" },
  { permission: "api_key:read", type: "api_key.changed" },
  { permission: "settings:read", type: "settings.changed" },
] as const satisfies readonly { permission: string; type: ResourceChangeType }[];

export const COCKPIT_STREAM_FAMILIES: readonly StreamFamily[] = [
  { permission: "execution:read", channel: "execution.status" },
  { permission: "workflow:read", channel: "workflow.lifecycle" },
  { permission: "skill:read", channel: "skill.lifecycle" },
  { permission: "connector:read", channel: "connector.oauth" },
  {
    permission: "workflow:read",
    channel: "notification.emitted",
    types: ["patch.proposed", "patch.applied"],
  },
  {
    permission: "connector:read",
    channel: "notification.emitted",
    types: ["connector.health_changed", "connector.auth_failed"],
  },
  {
    permission: "workflow:read",
    channel: "resource.lifecycle",
    types: RESOURCE_TYPES_BY_PERMISSION.workflow,
  },
  {
    permission: "schedule:read",
    channel: "resource.lifecycle",
    types: RESOURCE_TYPES_BY_PERMISSION.schedule,
  },
  {
    permission: "connector:read",
    channel: "resource.lifecycle",
    types: RESOURCE_TYPES_BY_PERMISSION.connector,
  },
  {
    permission: "task:read",
    channel: "resource.lifecycle",
    types: RESOURCE_TYPES_BY_PERMISSION.task,
    owner_scoped: "task",
  },
  ...LIST_CHANGE_FAMILIES.map(({ permission, type }) => ({
    permission,
    channel: "resource.lifecycle" as const,
    types: [type],
  })),
  { permission: "audit:read", channel: "resource.lifecycle" },
];

const COCKPIT_STREAM_ID_KEYS = [
  "execution_id",
  "workflow_id",
  "workflow_version_id",
  "connector_id",
  "patch_candidate_id",
  "skill_id",
  "schedule_id",
  "hook_id",
  "authority_id",
  "knowledge_source_id",
  "task_id",
  "task_run_id",
  "task_grant_id",
] as const;

type CockpitStreamIdKey = (typeof COCKPIT_STREAM_ID_KEYS)[number];

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export function projectCockpitPayload(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  const record = payload as Record<string, unknown>;
  for (const key of COCKPIT_STREAM_ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && ID_SHAPE.test(value)) out[key] = value;
  }
  return out;
}

type AttentionSubject = { subject: "connector" | "workflow" | "task"; key: CockpitStreamIdKey };

const CONNECTOR_SUBJECT: AttentionSubject = { subject: "connector", key: "connector_id" };
const WORKFLOW_SUBJECT: AttentionSubject = { subject: "workflow", key: "workflow_id" };
const TASK_SUBJECT: AttentionSubject = { subject: "task", key: "task_id" };

const WORKFLOW_ATTENTION_EVENTS = new Set(["workflow.automation_changed", "execution.failed"]);

export function cockpitAttentionSubject(type: string): AttentionSubject | null {
  if (type.startsWith("connector.")) return CONNECTOR_SUBJECT;
  if (WORKFLOW_ATTENTION_EVENTS.has(type) || type.startsWith("patch.")) return WORKFLOW_SUBJECT;
  if (type.startsWith("task.") || type.startsWith("task_run.")) return TASK_SUBJECT;
  return null;
}

const ATTENTION_NEUTRAL_EVENT = /^execution\.(?:queued|started|running|abort_requested|step\.)/;

export function cockpitEventTouchesAttention(type: string): boolean {
  return !ATTENTION_NEUTRAL_EVENT.test(type);
}

const SIGN_IN_FINISHED = "connector.oauth.signin_finished";
const SIGN_IN_OUTCOMES = new Set(["succeeded", "failed"]);
const SIGN_IN_REASONS = new Set(["provider_error", "missing_code", "token_exchange_failed"]);

function projectSignInOutcome(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const { outcome, reason } = payload as Record<string, unknown>;
  if (typeof outcome !== "string" || !SIGN_IN_OUTCOMES.has(outcome)) return {};
  return typeof reason === "string" && SIGN_IN_REASONS.has(reason)
    ? { outcome, reason }
    : { outcome };
}

export function projectCockpitEvent(row: {
  type: string;
  payload: unknown;
}): Record<string, string> {
  const out = {
    ...projectCockpitPayload(row.payload),
    ...(row.type === SIGN_IN_FINISHED ? projectSignInOutcome(row.payload) : {}),
  };
  const target = cockpitAttentionSubject(row.type);
  const subjectId = target ? out[target.key] : undefined;
  if (target && subjectId) out.attention_id = `${target.subject}:${subjectId}`;
  return out;
}

function ownTaskEvent(owner_id: string): SQL {
  return sql`exists (select 1 from ${tasks} where ${tasks.tenant_id} = ${events.tenant_id} and ${tasks.id}::text = ${events.payload} ->> 'task_id' and ${tasks.owner_id} = ${owner_id}::uuid)`;
}

function familyCond(family: StreamFamily, viewer: CockpitStreamViewer | undefined) {
  const channel = eq(events.channel, family.channel);
  const own = viewer && viewer.task_owner_id !== null ? [ownTaskEvent(viewer.task_owner_id)] : [];
  if (family.types) return and(channel, inArray(events.type, [...family.types]), ...own);
  if (family.channel !== "resource.lifecycle" || viewer?.task_owner_id === null) return channel;
  return and(channel, or(notInArray(events.type, [...RESOURCE_TYPES_BY_PERMISSION.task]), ...own));
}

export function cockpitStreamConds(
  tenant_id: string,
  permissions: ReadonlySet<string>,
  viewer?: CockpitStreamViewer,
): SQL[] | null {
  const admitted = COCKPIT_STREAM_FAMILIES.filter(
    (family) => permissions.has(family.permission) && (!family.owner_scoped || viewer),
  ).map((family) =>
    family.owner_scoped
      ? familyCond(family, viewer)
      : familyCond(family, family.types ? undefined : viewer),
  );
  if (admitted.length === 0) return null;
  const families = or(...admitted);
  return families ? [eq(events.tenant_id, tenant_id), families] : null;
}

export function cockpitStreamFallbackConds(tenant_id: string): SQL[] {
  return [eq(events.tenant_id, tenant_id), eq(events.channel, "__none__")];
}
