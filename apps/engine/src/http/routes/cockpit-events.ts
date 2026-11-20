import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import {
  COCKPIT_STREAM_FAMILIES,
  cockpitStreamConds,
  cockpitStreamFallbackConds,
  projectCockpitPayload,
} from "../../identity/index.ts";
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

export function registerCockpitEventRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/cockpit/events/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenantId = principal.tenant_id;
    const permissions = await cockpitStreamPermissions(db, principal);
    const conds = cockpitStreamConds(tenantId, permissions, {
      task_owner_id: hasBuiltinAdminRole(principal) ? null : principal.id,
    });
    return streamOutboxTail(c, {
      db,
      replay: "tail",
      conds: () => conds ?? cockpitStreamFallbackConds(tenantId),
      project: (row) => projectCockpitPayload(row.payload),
      hello: { version: OPENAPI_INFO.version },
      heartbeatMs: HEARTBEAT_MS,
    });
  });
}
