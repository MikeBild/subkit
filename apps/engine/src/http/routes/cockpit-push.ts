import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { EgressBlockedError } from "../../connectors/index.ts";
import type { Db } from "../../db/client.ts";
import {
  type CockpitPushContext,
  cockpitPushSubscriptionActive,
  prepareCockpitPushKey,
  removeCockpitPushSubscription,
  upsertCockpitPushSubscription,
} from "../../identity/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { AppEnv } from "../openapi.ts";

const SubscriptionBody = z
  .object({
    endpoint: z.string().url().max(4096),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{40,512}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/),
      })
      .strict(),
  })
  .strict()
  .openapi("CockpitPushSubscription");

const PushStatus = z.object({ subscribed: z.boolean() }).openapi("CockpitPushSubscriptionStatus");

const PushKey = z.object({ public_key: z.string() }).openapi("CockpitPushKey");
const PushError = z.object({ code: z.string(), message: z.string().optional() });

const statusRoute = createRoute({
  method: "get",
  path: "/v1/cockpit/push-subscription",
  tags: ["identity"],
  summary: "Read the current installed Cockpit app push subscription status",
  security: [{ browserSession: [] }],
  responses: {
    200: {
      description: "Push subscription status",
      content: { "application/json": { schema: PushStatus } },
    },
    401: {
      description: "Installation session required",
      content: { "application/json": { schema: PushError } },
    },
  },
});

const prepareRoute = createRoute({
  method: "post",
  path: "/v1/cockpit/push-subscription/prepare",
  tags: ["identity"],
  summary: "Prepare the current installed Cockpit app for explicit push opt-in",
  security: [{ browserSession: [] }],
  responses: {
    200: { description: "VAPID public key", content: { "application/json": { schema: PushKey } } },
    401: {
      description: "Installation session required",
      content: { "application/json": { schema: PushError } },
    },
  },
});

const updateRoute = createRoute({
  method: "put",
  path: "/v1/cockpit/push-subscription",
  tags: ["identity"],
  summary: "Store a push subscription for the current installed Cockpit app session",
  security: [{ browserSession: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: SubscriptionBody } } },
  },
  responses: {
    204: { description: "Stored" },
    400: {
      description: "Invalid push subscription",
      content: { "application/json": { schema: PushError } },
    },
    401: {
      description: "Installation session required",
      content: { "application/json": { schema: PushError } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/cockpit/push-subscription",
  tags: ["identity"],
  summary: "Remove the current installed Cockpit app session push subscription",
  security: [{ browserSession: [] }],
  responses: {
    204: { description: "Removed" },
    401: {
      description: "Installation session required",
      content: { "application/json": { schema: PushError } },
    },
  },
});

export type ResolveCockpitPushContext = (
  db: Db,
  request: Request,
  principal: ReturnType<typeof requireAuth>,
) => Promise<CockpitPushContext | null>;

export function registerCockpitPushRoutes(
  app: OpenAPIHono<AppEnv>,
  resolveContext: ResolveCockpitPushContext,
): void {
  const context = async (request: Request, appContext: Context<AppEnv>) =>
    await resolveContext(appContext.get("db"), request, requireAuth(appContext));
  app.openapi(statusRoute, async (c) => {
    const pushContext = await context(c.req.raw, c);
    if (!pushContext) return c.json({ code: "cockpit_installation_session_required" }, 401);
    return c.json(
      { subscribed: await cockpitPushSubscriptionActive(c.get("db"), pushContext) },
      200,
    );
  });
  app.openapi(prepareRoute, async (c) => {
    const pushContext = await context(c.req.raw, c);
    if (!pushContext) return c.json({ code: "cockpit_installation_session_required" }, 401);
    return c.json({ public_key: await prepareCockpitPushKey(c.get("db"), pushContext) }, 200);
  });
  app.openapi(updateRoute, async (c) => {
    const pushContext = await context(c.req.raw, c);
    if (!pushContext) return c.json({ code: "cockpit_installation_session_required" }, 401);
    const parsed = SubscriptionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { code: "invalid_push_subscription", message: "Invalid push subscription" },
        400,
      );
    try {
      await upsertCockpitPushSubscription(c.get("db"), pushContext, parsed.data);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof EgressBlockedError)
        return c.json({ code: error.code, message: "Push endpoint is not permitted" }, 400);
      if (error instanceof TypeError || error instanceof URL) {
        return c.json(
          { code: "invalid_push_subscription", message: "Invalid push subscription" },
          400,
        );
      }
      throw error;
    }
  });
  app.openapi(deleteRoute, async (c) => {
    const pushContext = await context(c.req.raw, c);
    if (!pushContext) return c.json({ code: "cockpit_installation_session_required" }, 401);
    await removeCockpitPushSubscription(c.get("db"), pushContext);
    return c.body(null, 204);
  });
}
