// GET /v1/cockpit/events/stream — the Cockpit's live change feed.
//
// The Cockpit reads every state through the REST surface; this stream only
// tells it WHEN something it may show has changed, so it refreshes instead of
// polling. Three properties make that safe to open for any signed-in person,
// where the tenant-wide `GET /v1/events/stream` needs `audit:read`:
//
//   - Permission filter in SQL. A row reaches the reader only when the reader
//     holds the tenant-wide read permission of its family — the same one the
//     list endpoint for that resource asks for. A family the reader may not
//     read is not in the WHERE clause at all.
//   - Ids only. Each frame's data is reduced to an allowlist of id keys;
//     names, messages, inputs and every other payload field stay behind.
//   - No startup replay. Without `Last-Event-ID` the stream starts at the
//     current tail (the page has just read current state). With it, the rows
//     after that id are replayed; `hello.truncated` says the replay hit its
//     cap and the client should refresh everything.
//
// `hello` also carries the engine version — the one `/v1/cockpit/bootstrap`
// reports — so a client that reconnects after a deploy learns that the bundle
// it runs is no longer the one being served.
//
// Hand-rolled outside the openapi() surface like the other SSE tails
// (docs/developers/input-surfaces.md).

import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import { events } from "../../db/schema/index.ts";
import { type OutboxChannel, RESOURCE_CHANGE_TYPES } from "../../pubsub/index.ts";
import { can } from "../../rbac/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";
import { streamOutboxTail } from "./sse-outbox-tail.ts";

/**
 * One family of rows the stream may carry: a channel, optionally narrowed to
 * named types, and the tenant-wide permission that reads it. A channel or
 * type absent from this table never reaches the Cockpit — `conversation.stream`
 * (turn content), `event.emitted` (manual emissions) and `file.*` among them.
 */
interface StreamFamily {
  permission: string;
  channel: OutboxChannel;
  types?: readonly string[];
}

const RESOURCE_TYPES_BY_PERMISSION = {
  workflow: RESOURCE_CHANGE_TYPES.filter((type) => type.startsWith("workflow.authority_")),
  schedule: RESOURCE_CHANGE_TYPES.filter((type) => type === "workflow.automation_changed"),
  connector: RESOURCE_CHANGE_TYPES.filter((type) => type.startsWith("connector.")),
};

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
];

/** The payload keys a frame may carry. Every value must look like an id. */
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
] as const;

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Reduce a payload to its id keys; anything else — or a non-id value — is dropped. */
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

/**
 * The WHERE clause for one reader: tenant first, then the OR of every family
 * the reader's permissions admit. Null when no family is admitted — the
 * stream then carries nothing but `hello` and heartbeats.
 */
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

/** The family permissions this principal holds, tenant-wide. */
export async function cockpitStreamPermissions(
  db: Db,
  principal: ResolvedPrincipal,
): Promise<Set<string>> {
  const wanted = [...new Set(COCKPIT_STREAM_FAMILIES.map((family) => family.permission))];
  const decisions = await Promise.all(
    wanted.map(async (permission) => ({
      permission,
      allow: (await can(db, { tenant_id: principal.tenant_id, principal, permission, quiet: true }))
        .allow,
    })),
  );
  return new Set(decisions.filter((d) => d.allow).map((d) => d.permission));
}

const HEARTBEAT_MS = 25_000;

export function registerCockpitEventRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/cockpit/events/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenantId = principal.tenant_id;
    const permissions = await cockpitStreamPermissions(db, principal);
    const conds = cockpitStreamConds(tenantId, permissions);
    return streamOutboxTail(c, {
      db,
      replay: "tail",
      // A reader with no readable family still gets `hello` (and with it the
      // version) — the condition then matches no row by construction.
      conds: () => conds ?? [eq(events.tenant_id, tenantId), eq(events.channel, "__none__")],
      project: (row) => projectCockpitPayload(row.payload),
      hello: { version: OPENAPI_INFO.version },
      heartbeatMs: HEARTBEAT_MS,
    });
  });
}
