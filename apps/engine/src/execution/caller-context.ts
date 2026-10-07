import { z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../auth/types.ts";

export const CallerContextSchema = z
  .object({
    tenantId: z.string().uuid(),
    principalId: z.string().min(1),
    principalKind: z.enum(["user", "system_account"]),
    provider: z.string().min(1),
    productId: z.string().min(1).nullable(),
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

function refuse(code: string): never {
  throw Object.assign(new Error(code), { code });
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
  });
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
