// Events HTTP surface.
//
//   POST /v1/events   — admin-only manual emission. Validates the
//                       payload against the zod schema in the
//                       catalog, writes an outbox row, and fans
//                       out to subscriptions when a pg-boss handle
//                       is available.
//   GET  /v1/events   — tail the tenant's outbox, filtered by
//                       channel and/or type.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { ErrorSchema, paginatedResponse } from "../../api/common-schemas.ts";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { writeEvent } from "../../db/events.ts";
import { events } from "../../db/schema/index.ts";
import { getBoss } from "../../queue/boss.ts";
import { EVENT_TYPES, validateEventPayload } from "../../webhooks/events/catalog.ts";
import { fanoutEvent } from "../../webhooks/outbound/fanout.ts";
import { BadRequestError, ForbiddenError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const EventSchema = z
  .object({
    id: z.number(),
    tenant_id: z.string(),
    channel: z.string(),
    type: z.string(),
    payload: z.unknown(),
    created_at: z.string(),
  })
  .openapi("OutboxEvent");

const ListResponse = paginatedResponse(EventSchema, "OutboxEventListResponse");

const EmitBody = z
  .object({
    type: z.enum(EVENT_TYPES as [string, ...string[]]),
    payload: z.record(z.string(), z.unknown()),
    channel: z.string().optional(),
  })
  .openapi("EmitEventBody");

const listRoute = createRoute({
  method: "get",
  path: "/v1/events",
  tags: ["events"],
  summary: "Tail outbox events for the caller's tenant",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
        channel: z.string().optional(),
        type: z.string().optional(),
      })
      .openapi("ListEventsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
  },
});

const emitRoute = createRoute({
  method: "post",
  path: "/v1/events",
  tags: ["events"],
  summary: "Manually emit an event (admin only)",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: EmitBody } } } },
  responses: {
    202: {
      description: "Accepted",
      content: { "application/json": { schema: z.object({ event_id: z.number() }) } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerEventRoutes(app: OpenAPIHono<AppEnv>): void {
  // Outbox events sit under audit:read — they describe the same
  // compliance surface as the audit log itself.
  app.use("/v1/events", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("audit:read")(c, next);
    if (c.req.method === "POST") return requirePermission("audit:read")(c, next);
    return next();
  });
  app.use("/v1/events/stream", async (c, next) => {
    return requirePermission("audit:read")(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const conds = [eq(events.tenant_id, principal.tenant_id)];
    if (q.channel) conds.push(eq(events.channel, q.channel));
    if (q.type) conds.push(eq(events.type, q.type));
    const rows = await db
      .select()
      .from(events)
      .where(and(...conds))
      .orderBy(desc(events.id))
      .limit(q.limit ?? 100);
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenant_id: r.tenant_id,
          channel: r.channel,
          type: r.type,
          payload: r.payload,
          created_at: r.created_at.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(emitRoute, async (c) => {
    const principal = requireAuth(c);
    if (!principal.roles.includes("admin")) {
      throw new ForbiddenError("admin_required");
    }
    const db = c.get("db");
    const body = c.req.valid("json");
    const check = validateEventPayload(body.type, body.payload);
    if (!check.ok) {
      throw new BadRequestError(`payload invalid: ${check.error}`);
    }
    const channel = (body.channel ?? "event.emitted") as
      | "execution.status"
      | "workflow.chain"
      | "connector.oauth"
      | "conversation.stream"
      | "event.emitted"
      | "notification.emitted"
      | "tunnel.state";
    const event_id = await db.transaction(async (tx) => {
      return await writeEvent(tx, {
        tenant_id: principal.tenant_id,
        channel,
        type: body.type,
        payload: body.payload,
      });
    });
    audit(
      {
        tenant_id: principal.tenant_id,
        action: AuditAction.EVENT_EMITTED,
        resource_type: "event",
        resource_id: String(event_id),
        result: "success",
        metadata: { type: body.type, channel },
      },
      db,
    );

    // Best-effort inline fanout so the caller sees immediate downstream
    // effect. If pg-boss isn't running (e.g. tests), skip silently.
    try {
      const bossOverride = (c as unknown as { get: (k: string) => unknown }).get("boss") as
        | ReturnType<typeof getBoss>
        | undefined;
      const boss = bossOverride ?? getBoss();
      await fanoutEvent({
        db,
        boss,
        tenant_id: principal.tenant_id,
        event_row_id: event_id,
        event_type: body.type,
        payload: body.payload,
      });
    } catch {
      /* boss not running; fanout will happen async via the listener */
    }
    return c.json({ event_id }, 202);
  });

  // -----------------------------------------------------------------
  // GET /v1/events/stream — tenant-wide SSE tail.
  //
  // Hand-rolled (outside the openapi() surface) because streamSSE
  // commandeers the response. On connect we:
  //
  //   1. Flush the last N outbox rows for the tenant. When the client
  //      supplied `Last-Event-ID`, we replay from the event immediately
  //      after that id instead.
  //   2. Poll the outbox every 250 ms for new rows. The poll is cheap
  //      because the events table is indexed on `(tenant_id, id)` and
  //      the query is always a `WHERE id > :cursor`.
  //   3. Terminate on `AbortSignal` — the node-server layer fires it
  //      when the client disconnects, so a closed client frees the
  //      polling loop immediately.
  //
  // The endpoint purposely does not plug into the pub/sub emitter.
  // Polling the outbox keeps replay and live semantics identical, and
  // the small constant-time poll avoids a second lifecycle to babysit
  // in the streaming code path.
  // -----------------------------------------------------------------
  app.get("/v1/events/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenantId = principal.tenant_id;

    const lastHeader = c.req.header("last-event-id");
    const lastEventId = lastHeader ? Number.parseInt(lastHeader, 10) : null;
    const replayLimit = 50;

    return streamSSE(c, async (stream) => {
      // Compose a serialisable frame from an outbox row.
      const write = async (row: { id: number; type: string; payload: unknown }) => {
        await stream.writeSSE({
          id: String(row.id),
          event: row.type,
          data: JSON.stringify(row.payload ?? {}),
        });
      };

      // 1. Replay. When a `Last-Event-ID` was supplied we replay every
      //    row strictly after it; otherwise we flush the most-recent
      //    `replayLimit` rows so fresh clients see recent history.
      let cursor = 0;
      if (Number.isFinite(lastEventId) && lastEventId !== null && lastEventId >= 0) {
        const replay = await db
          .select()
          .from(events)
          .where(and(eq(events.tenant_id, tenantId), gt(events.id, lastEventId)))
          .orderBy(asc(events.id))
          .limit(1_000);
        for (const row of replay) {
          await write(row);
          cursor = row.id;
        }
        if (cursor === 0) cursor = lastEventId;
      } else {
        const recent = await db
          .select()
          .from(events)
          .where(eq(events.tenant_id, tenantId))
          .orderBy(desc(events.id))
          .limit(replayLimit);
        const ordered = recent.slice().reverse();
        for (const row of ordered) {
          await write(row);
          cursor = Math.max(cursor, row.id);
        }
      }

      // 2. Announce the current tail so fresh clients know where they
      //    are. Mirrors the `hello` frame documented in
      //    docs/03-input-surfaces.md.
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ cursor }),
      });

      // 3. Poll loop. Stops as soon as the client disconnects.
      const signal = c.req.raw.signal;
      while (!signal.aborted) {
        const newRows = await db
          .select()
          .from(events)
          .where(and(eq(events.tenant_id, tenantId), gt(events.id, cursor)))
          .orderBy(asc(events.id))
          .limit(200);
        for (const row of newRows) {
          await write(row);
          cursor = row.id;
        }
        // Short poll cadence so live tests don't have to wait seconds
        // between ticks.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    });
  });
}
