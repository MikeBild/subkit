import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { cockpitInstallationIdFromPath } from "../../auth/index.ts";
import { EgressBlockedError } from "../../connectors/index.ts";
import type { Db } from "../../db/client.ts";
import {
  type CockpitPushContext,
  cockpitPushDeviceHandledByApp,
  cockpitPushSubscriptionActive,
  prepareCockpitPushKey,
  rebindCockpitBrowserPushSubscription,
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
    rebind: z.boolean().optional(),
    device: z.string().uuid().optional(),
  })
  .strict()
  .openapi("CockpitPushSubscription");

const PushStatus = z
  .object({ subscribed: z.boolean(), handled_by_app: z.boolean() })
  .openapi("CockpitPushSubscriptionStatus");
const PushStatusQuery = z.object({ device: z.string().uuid().optional() }).strict();

const PushKey = z.object({ public_key: z.string() }).openapi("CockpitPushKey");
const PushError = z.object({ code: z.string(), message: z.string().optional() });

const statusRoute = createRoute({
  method: "get",
  path: "/v1/cockpit/push-subscription",
  tags: ["identity"],
  summary: "Read the push subscription status of the current Cockpit session",
  security: [{ browserSession: [] }],
  request: { query: PushStatusQuery },
  responses: {
    200: {
      description: "Push subscription status",
      content: { "application/json": { schema: PushStatus } },
    },
    400: {
      description: "Invalid device",
      content: { "application/json": { schema: PushError } },
    },
    401: {
      description: "Cockpit browser session required",
      content: { "application/json": { schema: PushError } },
    },
  },
});

const prepareRoute = createRoute({
  method: "post",
  path: "/v1/cockpit/push-subscription/prepare",
  tags: ["identity"],
  summary: "Prepare the current Cockpit session for explicit push opt-in",
  security: [{ browserSession: [] }],
  responses: {
    200: { description: "VAPID public key", content: { "application/json": { schema: PushKey } } },
    401: {
      description: "Cockpit browser session required",
      content: { "application/json": { schema: PushError } },
    },
  },
});

const updateRoute = createRoute({
  method: "put",
  path: "/v1/cockpit/push-subscription",
  tags: ["identity"],
  summary: "Store or re-bind a push subscription for the current Cockpit session",
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
      description: "Cockpit browser session required",
      content: { "application/json": { schema: PushError } },
    },
    409: {
      description: "No push subscription of this user is bound to this browser",
      content: { "application/json": { schema: PushError } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/cockpit/push-subscription",
  tags: ["identity"],
  summary: "Remove the push subscription of the current Cockpit session",
  security: [{ browserSession: [] }],
  responses: {
    204: { description: "Removed" },
    401: {
      description: "Cockpit browser session required",
      content: { "application/json": { schema: PushError } },
    },
  },
});

type ResolveCockpitPushContext = (
  db: Db,
  request: Request,
  principal: ReturnType<typeof requireAuth>,
) => Promise<CockpitPushContext | null>;

function sessionRequired(request: Request) {
  return {
    code: cockpitInstallationIdFromPath(new URL(request.url).pathname)
      ? "cockpit_installation_session_required"
      : "browser_session_required",
  };
}

export function registerCockpitPushRoutes(
  app: OpenAPIHono<AppEnv>,
  resolveContext: ResolveCockpitPushContext,
): void {
  const context = async (request: Request, appContext: Context<AppEnv>) =>
    await resolveContext(appContext.get("db"), request, requireAuth(appContext));
  app.openapi(statusRoute, async (c) => {
    const pushContext = await context(c.req.raw, c);
    if (!pushContext) return c.json(sessionRequired(c.req.raw), 401);
    const { device } = c.req.valid("query");
    const db = c.get("db");
    return c.json(
      {
        subscribed: await cockpitPushSubscriptionActive(db, pushContext),
        handled_by_app: await cockpitPushDeviceHandledByApp(db, pushContext, device),
      },
      200,
    );
  });
  app.openapi(prepareRoute, async (c) => {
    const pushContext = await context(c.req.raw, c);
    if (!pushContext) return c.json(sessionRequired(c.req.raw), 401);
    return c.json({ public_key: await prepareCockpitPushKey(c.get("db"), pushContext) }, 200);
  });
  app.openapi(updateRoute, async (c) => {
    const pushContext = await context(c.req.raw, c);
    if (!pushContext) return c.json(sessionRequired(c.req.raw), 401);
    const parsed = SubscriptionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { code: "invalid_push_subscription", message: "Invalid push subscription" },
        400,
      );
    const { rebind, device, ...subscription } = parsed.data;
    const options = device ? { device } : {};
    try {
      if (pushContext.kind === "browser" && rebind) {
        const bound = await rebindCockpitBrowserPushSubscription(
          c.get("db"),
          pushContext,
          subscription,
          options,
        );
        if (!bound)
          return c.json(
            {
              code: "push_subscription_not_bound",
              message: "No push subscription of this user is bound to this browser",
            },
            409,
          );
        return c.body(null, 204);
      }
      await upsertCockpitPushSubscription(c.get("db"), pushContext, subscription, options);
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
    if (!pushContext) return c.json(sessionRequired(c.req.raw), 401);
    await removeCockpitPushSubscription(c.get("db"), pushContext);
    return c.body(null, 204);
  });
}
