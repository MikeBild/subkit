import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import {
  type BrowserSessionPayload,
  browserSessionForPrincipal,
} from "../../auth/browser-session.ts";
import { readOwnedTenant } from "../../identity/owned-tenant.ts";
import { IdentityRecoveryError } from "../../identity/recovery.ts";
import {
  requestOwnedTenantDeletion,
  TenantLifecycleError,
} from "../../identity/tenant-lifecycle.ts";
import { SelfServiceIdentityError } from "../../identity/tenant-status.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  type Rejection,
  reject,
} from "./index.ts";

export const OWNED_TENANT_REFUSED = "Verified owner browser identity or recovery proof required";

const BROWSER_SESSION = [{ browserSession: [] }] as const;
const NO_STORE = { "cache-control": "no-store" } as const;

const OwnedTenantSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  status: z.enum(["active", "suspended", "pending_deletion"]),
  deletion_requested_at: z.string().datetime().nullable(),
  deletion_scheduled_for: z.string().datetime().nullable(),
});

const DeletionBody = z.object({ confirmation: z.string().min(1).max(200) }).strict();

type OwnedTenant = Awaited<ReturnType<typeof readOwnedTenant>>;
type DeletionResult = Awaited<ReturnType<typeof requestOwnedTenantDeletion>>;

export function lifecycleErrorCode(error: unknown): string | null {
  return error instanceof SelfServiceIdentityError ||
    error instanceof TenantLifecycleError ||
    error instanceof IdentityRecoveryError
    ? error.code
    : null;
}

function lifecycleRejection(error: unknown): Rejection {
  const code = lifecycleErrorCode(error);
  if (code) return reject.forbidden(code);
  throw error;
}

async function ownerProof(scope: OperationScope): Promise<BrowserSessionPayload | Rejection> {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  const proof = scope.request ? await browserSessionForPrincipal(scope.request, principal) : null;
  if (!proof || principal.product_id) return reject.forbidden("verified_browser_identity_required");
  return proof;
}

export const readOwnedTenantOperation = defineOperation<undefined, OwnedTenant>({
  id: "identity.owned_tenant.read",
  summary: "Read the verified browser identity's own hosted tenant",
  permission: null,
  effect: "read",
  async handler(scope) {
    const proof = await ownerProof(scope);
    if (isRejection(proof)) return proof;
    try {
      return await readOwnedTenant(proof, scope.db);
    } catch (error) {
      return lifecycleRejection(error);
    }
  },
  http: {
    method: "get",
    path: "/v1/identity/owned-tenant",
    tags: ["identity"],
    security: BROWSER_SESSION,
    response: z.object({ tenant: OwnedTenantSchema.nullable() }),
    success: { status: 200, description: "Own tenant status" },
    errors: { 403: OWNED_TENANT_REFUSED },
    responseHeaders: () => NO_STORE,
    toInput: () => undefined,
    toBody: (tenant) => ({
      tenant: tenant
        ? {
            ...tenant,
            deletion_requested_at: tenant.deletion_requested_at?.toISOString() ?? null,
            deletion_scheduled_for: tenant.deletion_scheduled_for?.toISOString() ?? null,
          }
        : null,
    }),
  },
});

export const requestOwnedTenantDeletionOperation = defineOperation<
  z.infer<typeof DeletionBody>,
  DeletionResult
>({
  id: "identity.owned_tenant.request_deletion",
  summary: "Request deletion of the current owned hosted tenant after seven days",
  permission: null,
  effect: "write",
  audit: AuditAction.TENANT_DELETION_REQUESTED,
  async handler(scope, { confirmation }) {
    const proof = await ownerProof(scope);
    if (isRejection(proof)) return proof;
    try {
      return await requestOwnedTenantDeletion({ ...proof, confirmation }, scope.db);
    } catch (error) {
      return lifecycleRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/identity/owned-tenant/deletion",
    tags: ["identity"],
    security: BROWSER_SESSION,
    body: DeletionBody,
    response: z.object({
      tenant_id: z.uuid(),
      status: z.literal("pending_deletion"),
      deletion_scheduled_for: z.string().datetime(),
    }),
    success: { status: 200, description: "Tenant blocked immediately; deletion scheduled" },
    errors: { 403: OWNED_TENANT_REFUSED },
    responseHeaders: () => NO_STORE,
    toInput: ({ json }) => json as z.infer<typeof DeletionBody>,
    toBody: (result) => ({
      ...result,
      deletion_scheduled_for: result.deletion_scheduled_for.toISOString(),
    }),
  },
});
