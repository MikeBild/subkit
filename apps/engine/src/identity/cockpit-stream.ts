import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { events } from "../db/schema/index.ts";
import {
  type OutboxChannel,
  RESOURCE_CHANGE_TYPES,
  type ResourceChangeType,
} from "../pubsub/index.ts";

export interface StreamFamily {
  permission: string;
  channel: OutboxChannel;
  types?: readonly string[];
}

const RESOURCE_TYPES_BY_PERMISSION = {
  workflow: RESOURCE_CHANGE_TYPES.filter((type) => type.startsWith("workflow.authority_")),
  schedule: RESOURCE_CHANGE_TYPES.filter((type) => type === "workflow.automation_changed"),
  connector: RESOURCE_CHANGE_TYPES.filter((type) => type.startsWith("connector.")),
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
  ...LIST_CHANGE_FAMILIES.map(({ permission, type }) => ({
    permission,
    channel: "resource.lifecycle" as const,
    types: [type],
  })),
  { permission: "audit:read", channel: "resource.lifecycle" },
];

export const COCKPIT_STREAM_ID_KEYS = [
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
] as const;

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

export function cockpitStreamConds(
  tenant_id: string,
  permissions: ReadonlySet<string>,
): SQL[] | null {
  const admitted = COCKPIT_STREAM_FAMILIES.filter((family) =>
    permissions.has(family.permission),
  ).map((family) =>
    family.types
      ? and(eq(events.channel, family.channel), inArray(events.type, [...family.types]))
      : eq(events.channel, family.channel),
  );
  if (admitted.length === 0) return null;
  const families = or(...admitted);
  return families ? [eq(events.tenant_id, tenant_id), families] : null;
}

export function cockpitStreamFallbackConds(tenant_id: string): SQL[] {
  return [eq(events.tenant_id, tenant_id), eq(events.channel, "__none__")];
}
