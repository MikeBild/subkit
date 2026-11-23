import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/index.ts";
import {
  ATTENTION_KEY_MAX,
  SNOOZE_MAX_MS,
  snoozeAttention,
  unsnoozeAttention,
} from "../../operator/index.ts";
import { now } from "../../utils/index.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["operator"] as const;
export const ATTENTION_SNOOZE_PATH = "/v1/attention/snooze";
export const ATTENTION_UNSNOOZE_PATH = "/v1/attention/unsnooze";

const AttentionKey = z
  .string()
  .min(1)
  .max(ATTENTION_KEY_MAX)
  .describe(
    "The item to hide: `<id>|<class>|<reason>` of an attention item. When the item changes class or reason it shows again.",
  );

export const SnoozeAttentionBody = z
  .object({
    attention_key: AttentionKey,
    until: z.string().datetime({ offset: true }).describe("When the item shows again."),
  })
  .strict()
  .openapi("SnoozeAttentionBody");

export const UnsnoozeAttentionBody = z
  .object({ attention_key: AttentionKey })
  .strict()
  .openapi("UnsnoozeAttentionBody");

export const AttentionSnoozeSchema = z
  .object({
    attention_key: z.string(),
    snoozed: z.boolean(),
    until: z.string().nullable(),
  })
  .openapi("AttentionSnooze");

type SnoozeInput = z.infer<typeof SnoozeAttentionBody>;
type UnsnoozeInput = z.infer<typeof UnsnoozeAttentionBody>;
type SnoozeResult = z.infer<typeof AttentionSnoozeSchema>;

type Person = NonNullable<OperationScope["principal"]>;

function person(scope: OperationScope): Person | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  if (principal.kind !== "user")
    return reject.status(403, "person_required", "Only a person snoozes an attention item.");
  return principal;
}

function isRejected(value: Person | Rejection): value is Rejection {
  return (value as Rejection).rejected === true;
}

const ERRORS = {
  401: "Unauthorized",
  403: "person_required — only a person snoozes an attention item",
} as const;

export const snoozeAttentionOperation = defineOperation<SnoozeInput, SnoozeResult>({
  id: "attention.snooze",
  summary: "Hide one attention item for the signed-in person until a chosen time",
  permission: null,
  effect: "write",
  audit: AuditAction.ATTENTION_SNOOZED,
  async handler(scope, input) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    const plan = await snoozeAttention(
      scope.db,
      { tenant_id: scope.tenant_id, user_id: principal.id },
      { attention_key: input.attention_key, until: new Date(input.until) },
      new Date(now()),
    );
    if (!plan.ok)
      return reject.unprocessable(
        plan.reason === "snooze_in_past"
          ? "The snooze has to end in the future."
          : `A snooze lasts at most ${SNOOZE_MAX_MS / 86_400_000} days.`,
        undefined,
        plan.reason,
      );
    return {
      attention_key: input.attention_key,
      snoozed: true,
      until: plan.until.toISOString(),
    };
  },
  http: {
    method: "post",
    path: ATTENTION_SNOOZE_PATH,
    tags: TAGS,
    description:
      "Moves the item from `items` to `snoozed` in the attention list of this person only, and holds back its push notification. Other people still see it. The item returns by itself at `until`, or earlier when its class or reason changes. Snoozing again replaces the end.",
    body: SnoozeAttentionBody,
    response: AttentionSnoozeSchema,
    errors: {
      ...ERRORS,
      422: "snooze_in_past or snooze_too_long — the end lies in the past or more than 30 days ahead",
    },
    toInput: ({ json }) => json as SnoozeInput,
    toBody: (result) => result,
  },
});

export const unsnoozeAttentionOperation = defineOperation<UnsnoozeInput, SnoozeResult>({
  id: "attention.unsnooze",
  summary: "Show a snoozed attention item again for the signed-in person",
  permission: null,
  effect: "write",
  audit: AuditAction.ATTENTION_UNSNOOZED,
  async handler(scope, input) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    await unsnoozeAttention(
      scope.db,
      { tenant_id: scope.tenant_id, user_id: principal.id },
      input.attention_key,
    );
    return { attention_key: input.attention_key, snoozed: false, until: null };
  },
  http: {
    method: "post",
    path: ATTENTION_UNSNOOZE_PATH,
    tags: TAGS,
    description: "Ends the snooze at once. Answers the same way when the item was not snoozed.",
    body: UnsnoozeAttentionBody,
    response: AttentionSnoozeSchema,
    errors: ERRORS,
    toInput: ({ json }) => json as UnsnoozeInput,
    toBody: (result) => result,
  },
});
