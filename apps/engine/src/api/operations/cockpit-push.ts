import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { cockpitInstallationIdFromPath } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { EgressBlockedError } from "../../connectors/egress-guard.ts";
import type { Db } from "../../db/client.ts";
import {
  type CockpitPushContext,
  cockpitPushDeviceHandledByApp,
  cockpitPushSubscriptionActive,
  prepareCockpitPushKey,
  rebindCockpitBrowserPushSubscription,
  removeCockpitPushSubscription,
  upsertCockpitPushSubscription,
} from "../../identity/cockpit-push.ts";
import {
  defineOperation,
  type OperationScope,
  plainRejection,
  type Rejection,
  reject,
} from "./index.ts";

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

const BROWSER_SESSION = [{ browserSession: [] }] as const;
const SESSION_REQUIRED = { description: "Cockpit browser session required", schema: PushError };

export type ResolveCockpitPushContext = (
  db: Db,
  request: Request,
  principal: ResolvedPrincipal,
) => Promise<CockpitPushContext | null>;

type PushStatusInput = z.infer<typeof PushStatusQuery>;
type SubscriptionInput = z.infer<typeof SubscriptionBody>;

function sessionRequired(request: Request): Rejection {
  const code = cockpitInstallationIdFromPath(new URL(request.url).pathname)
    ? "cockpit_installation_session_required"
    : "browser_session_required";
  return plainRejection(401, code);
}

function invalidSubscription(): Rejection {
  return plainRejection(400, "invalid_push_subscription", "Invalid push subscription");
}

export function cockpitPushOperations(resolveContext: ResolveCockpitPushContext) {
  const withContext = async <R>(
    scope: OperationScope,
    run: (context: CockpitPushContext) => Promise<R | Rejection>,
  ): Promise<R | Rejection> => {
    const principal = scope.principal;
    const request = scope.request;
    if (!principal || !request) return reject.unauthorized();
    const context = await resolveContext(scope.db, request, principal);
    if (!context) return sessionRequired(request);
    return run(context);
  };

  const status = defineOperation<PushStatusInput, z.infer<typeof PushStatus>>({
    id: "cockpit.push_subscription.status",
    summary: "Read the push subscription status of the current Cockpit session",
    permission: null,
    effect: "read",
    handler: (scope, { device }) =>
      withContext(scope, async (context) => ({
        subscribed: await cockpitPushSubscriptionActive(scope.db, context),
        handled_by_app: await cockpitPushDeviceHandledByApp(scope.db, context, device),
      })),
    http: {
      method: "get",
      path: "/v1/cockpit/push-subscription",
      tags: ["identity"],
      security: BROWSER_SESSION,
      query: PushStatusQuery,
      response: PushStatus,
      success: { status: 200, description: "Push subscription status" },
      errors: {
        400: { description: "Invalid device", schema: PushError },
        401: SESSION_REQUIRED,
      },
      toInput: ({ query }) => query as PushStatusInput,
      toBody: (result) => result,
    },
  });

  const prepare = defineOperation<undefined, z.infer<typeof PushKey>>({
    id: "cockpit.push_subscription.prepare",
    summary: "Prepare the current Cockpit session for explicit push opt-in",
    permission: null,
    effect: "write",
    audit: AuditAction.COCKPIT_PUSH_KEY_PREPARED,
    handler: (scope) =>
      withContext(scope, async (context) => ({
        public_key: await prepareCockpitPushKey(scope.db, context),
      })),
    http: {
      method: "post",
      path: "/v1/cockpit/push-subscription/prepare",
      tags: ["identity"],
      security: BROWSER_SESSION,
      response: PushKey,
      success: { status: 200, description: "VAPID public key" },
      errors: { 401: SESSION_REQUIRED },
      toInput: () => undefined,
      toBody: (result) => result,
    },
  });

  const update = defineOperation<SubscriptionInput, null>({
    id: "cockpit.push_subscription.update",
    summary: "Store or re-bind a push subscription for the current Cockpit session",
    permission: null,
    effect: "write",
    audit: AuditAction.COCKPIT_PUSH_SUBSCRIPTION_UPSERTED,
    handler: (scope, input) =>
      withContext(scope, async (context) => {
        const { rebind, device, ...subscription } = input;
        const options = device ? { device } : {};
        try {
          if (context.kind === "browser" && rebind) {
            const bound = await rebindCockpitBrowserPushSubscription(
              scope.db,
              context,
              subscription,
              options,
            );
            if (!bound)
              return plainRejection(
                409,
                "push_subscription_not_bound",
                "No push subscription of this user is bound to this browser",
              );
            return null;
          }
          await upsertCockpitPushSubscription(scope.db, context, subscription, options);
          return null;
        } catch (error) {
          if (error instanceof EgressBlockedError)
            return plainRejection(400, error.code, "Push endpoint is not permitted");
          if (error instanceof TypeError || error instanceof URL) return invalidSubscription();
          throw error;
        }
      }),
    http: {
      method: "put",
      path: "/v1/cockpit/push-subscription",
      tags: ["identity"],
      security: BROWSER_SESSION,
      body: SubscriptionBody,
      bodyRequired: true,
      response: z.null(),
      success: { status: 204, description: "Stored" },
      errors: {
        400: { description: "Invalid push subscription", schema: PushError },
        401: SESSION_REQUIRED,
        409: {
          description: "No push subscription of this user is bound to this browser",
          schema: PushError,
        },
      },
      toInput: ({ json }) => json as SubscriptionInput,
      toBody: () => null,
    },
  });

  const remove = defineOperation<undefined, null>({
    id: "cockpit.push_subscription.remove",
    summary: "Remove the push subscription of the current Cockpit session",
    permission: null,
    effect: "write",
    audit: AuditAction.COCKPIT_PUSH_SUBSCRIPTION_REMOVED,
    handler: (scope) =>
      withContext(scope, async (context) => {
        await removeCockpitPushSubscription(scope.db, context);
        return null;
      }),
    http: {
      method: "delete",
      path: "/v1/cockpit/push-subscription",
      tags: ["identity"],
      security: BROWSER_SESSION,
      response: z.null(),
      success: { status: 204, description: "Removed" },
      errors: { 401: SESSION_REQUIRED },
      toInput: () => undefined,
      toBody: () => null,
    },
  });

  return { status, prepare, update, remove };
}
