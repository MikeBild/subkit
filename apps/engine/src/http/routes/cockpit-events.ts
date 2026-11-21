import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import {
  COCKPIT_STREAM_FAMILIES,
  cockpitEventTouchesAttention,
  cockpitStreamConds,
  cockpitStreamFallbackConds,
  projectCockpitEvent,
} from "../../identity/index.ts";
import {
  personalDelivery,
  type StreamDeliveryHint,
  streamDeliveryState,
} from "../../notifications/index.ts";
import { invalidateTenantState } from "../../operator/index.ts";
import { can, hasBuiltinAdminRole } from "../../rbac/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";
import { streamOutboxTail } from "./sse-outbox-tail.ts";

async function cockpitStreamPermissions(
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
const DELIVERY_HINT_MS = 30_000;

export type StreamViewerHint = StreamDeliveryHint | Readonly<Record<string, string>>;

function hintFields(hint: StreamViewerHint): Record<string, string> {
  if (hint === null) return {};
  return typeof hint === "string" ? { delivery: hint } : { ...hint };
}

export function streamDeliveryReader(
  read: (at: Date) => Promise<StreamViewerHint>,
  clock: () => number = Date.now,
): () => Promise<StreamViewerHint> {
  let cached: { until: number; value: Promise<StreamViewerHint> } | null = null;
  return () => {
    const at = clock();
    if (!cached || cached.until <= at)
      cached = { until: at + DELIVERY_HINT_MS, value: read(new Date(at)).catch(() => null) };
    return cached.value;
  };
}

export async function projectForViewer(
  row: { type: string; payload: unknown },
  hint: () => Promise<StreamViewerHint>,
): Promise<Record<string, string>> {
  const projected = projectCockpitEvent(row);
  if (!cockpitEventTouchesAttention(row.type)) return projected;
  return { ...projected, ...hintFields(await hint()) };
}

export async function viewerDeliveryState(
  hint: () => Promise<StreamViewerHint>,
): Promise<Record<string, string>> {
  return hintFields(await hint());
}

export function registerCockpitEventRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/cockpit/events/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenantId = principal.tenant_id;
    const permissions = await cockpitStreamPermissions(db, principal);
    const conds = cockpitStreamConds(tenantId, permissions, {
      task_owner_id: hasBuiltinAdminRole(principal) ? null : principal.id,
      viewer_id: principal.kind === "user" ? principal.id : null,
    });
    const hint = streamDeliveryReader(async (at) =>
      principal.kind === "user"
        ? streamDeliveryState(
            await personalDelivery(db, { tenant_id: tenantId, user_id: principal.id }, at),
          )
        : null,
    );
    return streamOutboxTail(c, {
      db,
      replay: "tail",
      conds: () => conds ?? cockpitStreamFallbackConds(tenantId),
      project: (row) => projectForViewer(row, hint),
      hello: { version: OPENAPI_INFO.version, heartbeat_ms: HEARTBEAT_MS },
      viewerState: () => viewerDeliveryState(hint),
      heartbeatMs: HEARTBEAT_MS,
      onRows: (rows) => {
        if (rows.some((row) => cockpitEventTouchesAttention(row.type)))
          invalidateTenantState(tenantId);
      },
    });
  });
}
