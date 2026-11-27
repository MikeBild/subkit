import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { VaultPaymentStatus } from "../../db/index.ts";
import {
  approveVaultPayment,
  cvvValid,
  listVaultPayments,
  type PaymentDecision,
  rejectVaultPayment,
  type VaultPaymentView,
} from "../../vault/index.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["vault"] as const;

const VaultPaymentSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["pending", "approved", "consumed", "expired", "rejected"]),
    origin: z.string(),
    amount_minor: z.number().int(),
    currency: z.string(),
    card: z.object({ brand: z.string(), last4: z.string() }),
    expires_at: z.string(),
    created_at: z.string(),
    conversation_id: z.string().nullable(),
    task_run_id: z.string().nullable(),
  })
  .openapi("VaultPayment");

const VaultPaymentListSchema = z
  .object({ items: z.array(VaultPaymentSchema) })
  .openapi("VaultPaymentListResponse");

const VaultPaymentDecisionSchema = z
  .object({
    payment: VaultPaymentSchema,
    resume: z
      .object({ conversation_id: z.string(), tool_call_id: z.string() })
      .nullable()
      .describe(
        "The paused chat step this payment belongs to. Answer it right away with POST /v1/conversations/{conversation_id}/tool-calls/{tool_call_id}/respond and output {confirmed: true} after an approval or {confirmed: false} after a rejection; the device ticket lives 60 seconds. Null for a workflow run, which continues by itself.",
      ),
  })
  .openapi("VaultPaymentDecision");

const PaymentListQuery = z.object({
  status: z.enum(["pending", "approved", "consumed", "expired", "rejected"]).optional(),
});

const ApproveBody = z
  .object({
    cvv: z
      .string()
      .regex(/^[0-9]{3,4}$/)
      .describe("The card's security code. It is never stored; it goes to the device once."),
  })
  .strict()
  .openapi("VaultPaymentApproveBody");

interface DecisionResult {
  readonly payment: VaultPaymentView;
  readonly resume: { readonly conversation_id: string; readonly tool_call_id: string } | null;
}

function owner(scope: OperationScope): ResolvedPrincipal | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  const delegated =
    principal.api_key_id !== undefined ||
    principal.via !== undefined ||
    (principal.credential_origin ?? null) !== null;
  if (principal.kind !== "user" || delegated)
    return reject.forbidden("only the card owner, signed in themselves, decides on a payment", {
      reason: "not_card_owner",
    });
  return principal;
}

function decisionRejection(decision: Extract<PaymentDecision, { ok: false }>): Rejection {
  switch (decision.code) {
    case "payment_not_found":
      return reject.notFound("payment");
    case "not_card_owner":
      return reject.forbidden("only the card owner decides on this payment", {
        reason: "not_card_owner",
      });
    case "payment_expired":
      return reject.status(410, "payment_expired", "the payment request expired");
    case "card_changed":
      return reject.conflict(
        "the card changed since the payment was requested",
        undefined,
        "card_changed",
      );
    case "payment_not_pending":
      return reject.conflict("the payment was already decided", undefined, "payment_not_pending");
  }
}

function resumeOf(decision: Extract<PaymentDecision, { ok: true }>): DecisionResult["resume"] {
  const conversation_id = decision.payment.conversation_id;
  return conversation_id === null || decision.tool_call_id === null
    ? null
    : { conversation_id, tool_call_id: decision.tool_call_id };
}

export const listVaultPaymentsOperation = defineOperation<
  z.infer<typeof PaymentListQuery>,
  { items: VaultPaymentView[] }
>({
  id: "vault.payment.list",
  summary: "List your own payment requests: shop, amount and card brand and last 4 digits only",
  permission: null,
  effect: "read",
  handler: async (scope, query) => {
    const principal = owner(scope);
    if ("rejected" in principal) return principal;
    return {
      items: await listVaultPayments(
        scope.db,
        {
          tenant_id: scope.tenant_id,
          owner_user_id: principal.id,
          status: query.status as VaultPaymentStatus | undefined,
        },
        new Date(),
      ),
    };
  },
  http: {
    method: "get",
    path: "/v1/vault/payments",
    tags: TAGS,
    query: PaymentListQuery,
    response: VaultPaymentListSchema,
    errors: { 403: "Only a person signed in themselves sees their payments" },
    toInput: ({ query }) => query as z.infer<typeof PaymentListQuery>,
    toBody: (result) => result,
  },
});

export const approveVaultPaymentOperation = defineOperation<
  { readonly id: string; readonly cvv: string },
  DecisionResult
>({
  id: "vault.payment.approve",
  summary:
    "Approve one payment with the card's security code; the code is never stored and goes to the device once, within 60 seconds",
  permission: null,
  effect: "write",
  audit: AuditAction.VAULT_PAYMENT_APPROVED,
  handler: async (scope, input) => {
    const principal = owner(scope);
    if ("rejected" in principal) return principal;
    if (!cvvValid(input.cvv)) return reject.badRequest("the security code has 3 or 4 digits");
    const decision = await approveVaultPayment(
      scope.db,
      { tenant_id: scope.tenant_id, id: input.id, actor_id: principal.id, cvv: input.cvv },
      new Date(),
    );
    if (!decision.ok) return decisionRejection(decision);
    return { payment: decision.payment, resume: resumeOf(decision) };
  },
  http: {
    method: "post",
    path: "/v1/vault/payments/{id}/approve",
    tags: TAGS,
    params: IdParam,
    body: ApproveBody,
    bodyRequired: true,
    response: VaultPaymentDecisionSchema,
    errors: {
      400: "The security code has 3 or 4 digits",
      403: "Only the card owner approves",
      404: "Not found",
      409: "Already decided, or the card changed",
      410: "Expired",
    },
    responseHeaders: () => ({ "Cache-Control": "no-store" }),
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      cvv: (json as { cvv: string }).cvv,
    }),
    toBody: (result) => result,
  },
});

export const rejectVaultPaymentOperation = defineOperation<{ readonly id: string }, DecisionResult>(
  {
    id: "vault.payment.reject",
    summary: "Reject one payment request; nothing is paid",
    permission: null,
    effect: "write",
    audit: AuditAction.VAULT_PAYMENT_REJECTED,
    handler: async (scope, input) => {
      const principal = owner(scope);
      if ("rejected" in principal) return principal;
      const decision = await rejectVaultPayment(
        scope.db,
        { tenant_id: scope.tenant_id, id: input.id, actor_id: principal.id },
        new Date(),
      );
      if (!decision.ok) return decisionRejection(decision);
      return { payment: decision.payment, resume: resumeOf(decision) };
    },
    http: {
      method: "post",
      path: "/v1/vault/payments/{id}/reject",
      tags: TAGS,
      params: IdParam,
      response: VaultPaymentDecisionSchema,
      errors: {
        403: "Only the card owner rejects",
        404: "Not found",
        409: "Already decided",
        410: "Expired",
      },
      toInput: ({ param }) => ({ id: (param as { id: string }).id }),
      toBody: (result) => result,
    },
  },
);
