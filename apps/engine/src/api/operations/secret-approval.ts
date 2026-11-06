import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  approvePendingSecretVersion,
  listPendingSecretVersions,
  type PendingSecretVersion,
  rejectPendingSecretVersion,
} from "../../runtime-config/pending-secrets.ts";
import { RuntimeConfigNotFoundError } from "../../runtime-config/service.ts";
import { defineOperation, isRejection, type OperationScope, reject } from "./index.ts";

const TAGS = ["secrets"] as const;

const PendingSecretSchema = z
  .object({
    name: z.string(),
    version: z.number().int().positive(),
    reference: z.string(),
    prepared_by: z.string(),
    pending_since: z.string(),
    bindings: z.array(z.string()),
  })
  .openapi("PendingSecretVersion");

const PendingSecretListResponse = z
  .object({ items: z.array(PendingSecretSchema) })
  .openapi("PendingSecretVersionListResponse");

const ApprovalResponse = z
  .object({
    name: z.string(),
    version: z.number().int().positive(),
    bindings: z.array(
      z.object({
        path: z.string(),
        outcome: z.enum(["rebound", "failed"]),
        detail: z.string().nullable(),
      }),
    ),
  })
  .openapi("SecretApprovalResponse");

const RejectionResponse = z
  .object({ name: z.string(), version: z.number().int().positive(), revoked_at: z.string() })
  .openapi("SecretRejectionResponse");

const Params = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
  version: z.coerce.number().int().positive(),
});

interface SecretVersionInput {
  readonly name: string;
  readonly version: number;
}

type Approval = Awaited<ReturnType<typeof approvePendingSecretVersion>>;
type Revocation = Awaited<ReturnType<typeof rejectPendingSecretVersion>>;

function secretVersionInput(param: unknown): SecretVersionInput {
  const { name, version } = param as SecretVersionInput;
  return { name, version };
}

async function settle<T>(change: () => Promise<T>) {
  try {
    return await change();
  } catch (error) {
    if (error instanceof RuntimeConfigNotFoundError) return reject.notFound("prepared version");
    throw error;
  }
}

function secretAudit(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  { name, version }: SecretVersionInput,
) {
  return {
    tenant_id: scope.tenant_id,
    actor_type:
      principal.kind === "system_account" ? ("system_account" as const) : ("user" as const),
    actor_id: principal.id,
    resource_type: "runtime_secret",
    resource_id: `secret://${name}/${version}`,
  };
}

export const listPendingSecretVersionsOperation = defineOperation<null, PendingSecretVersion[]>({
  id: "secret_approval.list",
  summary: "Prepared secret versions waiting for a person",
  permission: "settings:read:global",
  effect: "read",
  handler: (scope) => listPendingSecretVersions(scope.db),
  http: {
    method: "get",
    path: "/v1/secret-approvals",
    tags: TAGS,
    response: PendingSecretListResponse,
    toInput: () => null,
    toBody: (items) => ({
      items: items.map((item) => ({ ...item, pending_since: item.pending_since.toISOString() })),
    }),
  },
});

export const approvePendingSecretVersionOperation = defineOperation<SecretVersionInput, Approval>({
  id: "secret_approval.approve",
  summary: "Approve a prepared version: it becomes current and its bindings are re-pinned",
  permission: "settings:write:global",
  effect: "write",
  audit: AuditAction.SECRET_VERSION_APPROVED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const outcome = await settle(() =>
      approvePendingSecretVersion(scope.db, { ...input, created_by: principal.id }),
    );
    if (isRejection(outcome)) return outcome;
    await auditAwait(
      {
        ...secretAudit(scope, principal, input),
        action: AuditAction.SECRET_VERSION_APPROVED,
        result: outcome.bindings.some((b) => b.outcome === "failed") ? "error" : "success",
        metadata: {
          request_source: scope.request_source,
          name: input.name,
          version: input.version,
          bindings: outcome.bindings,
        },
      },
      scope.db,
    );
    return outcome;
  },
  http: {
    method: "post",
    path: "/v1/secret-approvals/{name}/{version}/approve",
    tags: TAGS,
    params: Params,
    response: ApprovalResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => secretVersionInput(param),
    toBody: (outcome) => outcome,
  },
});

export const rejectPendingSecretVersionOperation = defineOperation<SecretVersionInput, Revocation>({
  id: "secret_approval.reject",
  summary: "Reject a prepared version: it is revoked and never becomes current",
  permission: "settings:write:global",
  effect: "write",
  audit: AuditAction.SECRET_VERSION_REJECTED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const outcome = await settle(() => rejectPendingSecretVersion(scope.db, input));
    if (isRejection(outcome)) return outcome;
    await auditAwait(
      {
        ...secretAudit(scope, principal, input),
        action: AuditAction.SECRET_VERSION_REJECTED,
        result: "success",
        metadata: {
          request_source: scope.request_source,
          name: input.name,
          version: input.version,
        },
      },
      scope.db,
    );
    return outcome;
  },
  http: {
    method: "post",
    path: "/v1/secret-approvals/{name}/{version}/reject",
    tags: TAGS,
    params: Params,
    response: RejectionResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => secretVersionInput(param),
    toBody: (outcome) => ({ ...outcome, revoked_at: outcome.revoked_at.toISOString() }),
  },
});
