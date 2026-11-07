import { z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { RequestSource } from "../observability/service-metadata.ts";

export const CallerContextSchema = z
  .object({
    tenantId: z.string().uuid(),
    principalId: z.string().min(1),
    principalKind: z.enum(["user", "system_account"]),
    provider: z.string().min(1),
    productId: z.string().min(1).nullable(),
    subject: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (caller) =>
      (caller.provider === "portal_token" &&
        caller.principalKind === "user" &&
        caller.productId === null) ||
      z.string().uuid().safeParse(caller.principalId).success,
    { path: ["principalId"], message: "This caller requires a UUID principal identifier." },
  );

export type CallerContext = z.infer<typeof CallerContextSchema>;

export function callerAuditActorId(caller: CallerContext | null | undefined): string | null {
  const id = caller?.principalId;
  return id && z.string().uuid().safeParse(id).success ? id : null;
}

const CALLER_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  caller_saved_workflow_required:
    "This caller can only run a saved workflow version, not a draft. Product callers run only saved workflows of their own product: save the workflow, then run the saved version.",
  caller_product_mismatch:
    "This caller does not match the workflow's product. A product-bound workflow runs only for a caller of that product: save the workflow, then run it as that product's caller.",
};

function refuse(code: string): never {
  throw Object.assign(new Error(CALLER_REFUSAL_MESSAGES[code] ?? code), { code });
}

export function assertCallerExecutionSource(
  principal: ResolvedPrincipal | null | undefined,
  sourceKind: "saved" | "draft" | "step",
): void {
  if (principal?.product_id && sourceKind !== "saved") refuse("caller_saved_workflow_required");
}

export function callerFromPrincipal(
  principal: ResolvedPrincipal | null | undefined,
  tenantId: string,
  productId?: string,
  requiredKind?: CallerContext["principalKind"],
): CallerContext | null {
  if (!principal) {
    if (productId || requiredKind) refuse("caller_required");
    return null;
  }
  if (requiredKind && principal.kind !== requiredKind) refuse("caller_kind_mismatch");
  if (principal.tenant_id !== tenantId) refuse("caller_tenant_mismatch");
  if (principal.product_id && principal.product_id !== productId) refuse("caller_product_mismatch");
  if (productId && principal.product_id !== productId) refuse("caller_product_mismatch");
  return CallerContextSchema.parse({
    tenantId: principal.tenant_id,
    principalId: principal.id,
    principalKind: principal.kind,
    provider: principal.provider,
    productId: principal.product_id ?? null,
    ...(principal.subject && principal.product_id ? { subject: principal.subject } : {}),
  });
}

export function assertExecutionPrivacySupported(
  requestSource: RequestSource,
  executionPrivacy: string | null | undefined,
): void {
  if (requestSource === "chat" && executionPrivacy === "sensitive")
    throw Object.assign(new Error("Sensitive execution is unavailable on conversation surfaces."), {
      code: "sensitive_execution_unsupported",
    });
}

export type WorkflowDispatchRefusal =
  | "caller_kind_mismatch"
  | "caller_product_mismatch"
  | "sensitive_execution_unsupported";

interface WorkflowDispatchBoundary {
  product_id?: string | null;
  required_caller_kind?: string | null;
  execution_privacy?: string | null;
}

export function workflowDispatchRefusal(
  boundary: WorkflowDispatchBoundary,
  principal: Pick<ResolvedPrincipal, "kind" | "product_id">,
  requestSource?: RequestSource,
): WorkflowDispatchRefusal | null {
  const productId = boundary.product_id ?? undefined;
  if (boundary.required_caller_kind && principal.kind !== boundary.required_caller_kind)
    return "caller_kind_mismatch";
  if (principal.product_id && principal.product_id !== productId) return "caller_product_mismatch";
  if (productId && principal.product_id !== productId) return "caller_product_mismatch";
  if (requestSource === "chat" && boundary.execution_privacy === "sensitive")
    return "sensitive_execution_unsupported";
  return null;
}

export function assertCallerMatches(
  caller: CallerContext | null,
  tenantId: string,
  productId: string | undefined,
  requiredKind?: CallerContext["principalKind"],
): void {
  if (!caller) {
    if (productId || requiredKind) refuse("caller_required");
    return;
  }
  if (requiredKind && caller.principalKind !== requiredKind) refuse("caller_kind_mismatch");
  if (caller.tenantId !== tenantId) refuse("caller_tenant_mismatch");
  if (caller.productId && caller.productId !== productId) refuse("caller_product_mismatch");
  if (productId && caller.productId !== productId) refuse("caller_product_mismatch");
}
