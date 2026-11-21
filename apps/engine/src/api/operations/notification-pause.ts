import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  readNotificationPause,
  writeNotificationPause,
} from "../../identity/notification-pause-store.ts";
import {
  PAUSE_MAX_MINUTES,
  type PauseView,
  planPause,
} from "../../notifications/notification-pause.ts";
import { now } from "../../utils/clock.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["identity"] as const;
export const NOTIFICATION_PAUSE_PATH = "/v1/identity/me/notification-pause";

export const NotificationPauseSchema = z
  .object({
    paused: z
      .boolean()
      .describe(
        "Whether push notifications and desktop banners are held back right now. Attention items and counts keep counting either way.",
      ),
    mode: z
      .enum(["until", "until_resumed"])
      .nullable()
      .describe(
        "until: the pause ends by itself at `until`. until_resumed: it lasts until resumed.",
      ),
    paused_at: z.string().nullable(),
    until: z.string().nullable(),
  })
  .openapi("NotificationPause");

export const PauseNotificationsBody = z
  .discriminatedUnion("mode", [
    z
      .object({ mode: z.literal("for"), minutes: z.number().int().min(1).max(PAUSE_MAX_MINUTES) })
      .strict(),
    z.object({ mode: z.literal("until"), until: z.string().datetime({ offset: true }) }).strict(),
    z.object({ mode: z.literal("until_resumed") }).strict(),
  ])
  .openapi("PauseNotificationsBody");

type PauseInput = z.infer<typeof PauseNotificationsBody>;

function person(scope: OperationScope): ResolvedPrincipal | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  if (principal.kind !== "user")
    return reject.status(403, "person_required", "A notification pause belongs to a person.");
  return principal;
}

function isRejected(value: ResolvedPrincipal | Rejection): value is Rejection {
  return (value as Rejection).rejected === true;
}

function body(view: PauseView) {
  return {
    paused: view.paused,
    mode: view.mode,
    paused_at: view.paused_at ? view.paused_at.toISOString() : null,
    until: view.until ? view.until.toISOString() : null,
  };
}

const ERRORS = {
  401: "Unauthorized",
  403: "person_required — only a person pauses notifications",
  404: "Not found",
} as const;

export const getNotificationPauseOperation = defineOperation<null, PauseView>({
  id: "identity.me.notification_pause.get",
  summary: "Read whether the signed-in person has paused notifications",
  permission: null,
  effect: "read",
  async handler(scope) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    return readNotificationPause(
      scope.db,
      { tenant_id: scope.tenant_id, user_id: principal.id },
      new Date(now()),
    );
  },
  http: {
    method: "get",
    path: NOTIFICATION_PAUSE_PATH,
    tags: TAGS,
    response: NotificationPauseSchema,
    errors: ERRORS,
    toInput: () => null,
    toBody: body,
  },
});

export const pauseNotificationsOperation = defineOperation<PauseInput, PauseView>({
  id: "identity.me.notification_pause.put",
  summary: "Pause push notifications and desktop banners for the signed-in person",
  permission: null,
  effect: "write",
  audit: AuditAction.USER_NOTIFICATIONS_PAUSED,
  async handler(scope, input) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    const at = new Date(now());
    const plan = planPause(
      input.mode === "until" ? { mode: "until", until: new Date(input.until) } : input,
      at,
    );
    if (!plan.ok)
      return reject.unprocessable(
        plan.reason === "pause_in_past"
          ? "The pause has to end in the future."
          : `A pause lasts at most ${PAUSE_MAX_MINUTES / 1440} days.`,
        undefined,
        plan.reason,
      );
    const view = await writeNotificationPause(
      scope.db,
      { tenant_id: scope.tenant_id, user_id: principal.id },
      { paused_at: plan.paused_at, paused_until: plan.paused_until },
      at,
      "pause",
    );
    return view ?? reject.notFound("user");
  },
  http: {
    method: "put",
    path: NOTIFICATION_PAUSE_PATH,
    tags: TAGS,
    description:
      "Holds back push notifications and desktop banners until the chosen time or until resumed. The Cockpit event stream marks announcements with `delivery: held` and `held_by: pause`. Critical items still notify when the person opted into the critical breakthrough. Attention items and counts are never held. A new pause replaces the current one.",
    body: PauseNotificationsBody,
    response: NotificationPauseSchema,
    errors: {
      ...ERRORS,
      422: "pause_in_past or pause_too_long — the end lies in the past or more than 30 days ahead",
    },
    toInput: ({ json }) => json as PauseInput,
    toBody: body,
  },
});

export const resumeNotificationsOperation = defineOperation<null, PauseView>({
  id: "identity.me.notification_pause.delete",
  summary: "Resume notifications for the signed-in person",
  permission: null,
  effect: "write",
  audit: AuditAction.USER_NOTIFICATIONS_RESUMED,
  async handler(scope) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    const view = await writeNotificationPause(
      scope.db,
      { tenant_id: scope.tenant_id, user_id: principal.id },
      { paused_at: null, paused_until: null },
      new Date(now()),
      "resume",
    );
    return view ?? reject.notFound("user");
  },
  http: {
    method: "delete",
    path: NOTIFICATION_PAUSE_PATH,
    tags: TAGS,
    description:
      "Ends the pause at once. What is still waiting for the person reaches them with the next notification round.",
    response: NotificationPauseSchema,
    errors: ERRORS,
    toInput: () => null,
    toBody: body,
  },
});
