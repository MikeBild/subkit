// Tunnel HTTP surface.
//
//   GET    /v1/tunnels         — list registered tunnels for the tenant.
//   GET    /v1/tunnels/:id     — fetch one, including targets + heartbeat.
//   POST   /v1/tunnels         — pre-register a tunnel row without an
//                                open socket. Useful for dashboards that
//                                want the row materialised before an agent
//                                ever boots.
//   DELETE /v1/tunnels/:id     — unregister + close any live socket.
//
// The WebSocket upgrade at `/v1/tunnels/ws` is served by the dedicated
// `startTunnelWsServer` helper (Bun.serve required).

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { tunnelRegistry } from "../../tunnels/registry.ts";
import {
  deleteTunnel,
  fingerprintAgentToken,
  getTunnel,
  listTunnels,
  upsertTunnel,
} from "../../tunnels/service.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const TunnelTargetSchema = z
  .object({
    id: z.string(),
    target_name: z.string(),
    concurrency_cap: z.number().int(),
  })
  .openapi("TunnelTarget");

const TunnelSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    name: z.string(),
    state: z.enum(["registered", "connected", "disconnected"]),
    last_seen_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    targets: z.array(TunnelTargetSchema),
    in_flight: z.number().int().nonnegative(),
  })
  .openapi("Tunnel");

const TunnelListResponse = paginatedResponse(TunnelSchema, "TunnelListResponse");

const CreateTunnelBody = z
  .object({
    name: z.string().min(1),
    targets: z
      .array(
        z.object({
          name: z.string().min(1),
          local_base_url: z.string().min(1),
        }),
      )
      .min(1),
  })
  .openapi("CreateTunnelBody");

const listRoute = createRoute({
  method: "get",
  path: "/v1/tunnels",
  tags: ["tunnels"],
  summary: "List tunnels",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: TunnelListResponse } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/tunnels/{id}",
  tags: ["tunnels"],
  summary: "Fetch a tunnel",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TunnelSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/tunnels",
  tags: ["tunnels"],
  summary: "Pre-register a tunnel row (no live socket)",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateTunnelBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TunnelSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/tunnels/{id}",
  tags: ["tunnels"],
  summary: "Delete a tunnel",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function serialise(row: {
  id: string;
  tenant_id: string;
  name: string;
  state: "registered" | "connected" | "disconnected";
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
  targets: Array<{ id: string; target_name: string; concurrency_cap: number }>;
}) {
  const stats = tunnelRegistry.stats();
  const in_flight = stats
    .filter((s) => s.tenant_id === row.tenant_id)
    .filter((s) => row.targets.some((t) => t.target_name === s.target))
    .reduce((sum, s) => sum + s.in_flight, 0);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    state: row.state,
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    targets: row.targets.map((t) => ({
      id: t.id,
      target_name: t.target_name,
      concurrency_cap: t.concurrency_cap,
    })),
    in_flight,
  };
}

export function registerTunnelRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC: tunnel CRUD is gated on tunnel:read / tunnel:write / tunnel:delete.
  // The WebSocket upgrade at /v1/tunnels/ws still uses tunnel:agent via
  // the dedicated ws-server.
  app.use("/v1/tunnels", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("tunnel:read")(c, next);
    if (c.req.method === "POST") return requirePermission("tunnel:write")(c, next);
    return next();
  });
  app.use("/v1/tunnels/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("tunnel:read", () => ({ type: "tunnel", id }))(c, next);
    }
    if (c.req.method === "DELETE") {
      return requirePermission("tunnel:delete", () => ({ type: "tunnel", id }))(c, next);
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await listTunnels(principal.tenant_id, db);
    return c.json({ items: rows.map(serialise) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await getTunnel(principal.tenant_id, id, db);
    if (!row) throw new NotFoundError("tunnel");
    return c.json(serialise(row), 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    // No token fingerprint yet — pre-registration is a hint, so we hash
    // a placeholder until the agent connects with its real key.
    const placeholder = fingerprintAgentToken(`pre-register:${principal.tenant_id}:${body.name}`);
    const { tunnel, targets } = await upsertTunnel(
      {
        tenant_id: principal.tenant_id,
        name: body.name,
        agent_token_sha256: placeholder,
        state: "registered",
        targets: body.targets,
      },
      db,
    );
    audit(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.TUNNEL_REGISTERED,
        resource_type: "tunnel",
        resource_id: tunnel.id,
        result: "success",
        metadata: { name: body.name, pre_registered: true },
      },
      db,
    );
    return c.json(serialise({ ...tunnel, targets }), 201);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await getTunnel(principal.tenant_id, id, db);
    if (!row) throw new NotFoundError("tunnel");
    for (const t of row.targets) {
      tunnelRegistry.detach(principal.tenant_id, t.target_name);
    }
    const ok = await deleteTunnel(principal.tenant_id, id, db);
    if (!ok) throw new NotFoundError("tunnel");
    audit(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.TUNNEL_UNREGISTERED,
        resource_type: "tunnel",
        resource_id: id,
        result: "success",
        metadata: { name: row.name },
      },
      db,
    );
    return c.body(null, 204);
  });
}
