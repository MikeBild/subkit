import { z } from "zod";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";

const SensitivePayloadSchema = z
  .object({
    $sensitive: z.literal(true),
    ciphertext: z.string(),
    iv: z.string(),
    auth_tag: z.string(),
  })
  .strict();

export function isSensitivePayload(value: unknown): boolean {
  return SensitivePayloadSchema.safeParse(value).success;
}

export function protectExecutionPayload(
  value: unknown,
  tenant: string,
  execution: string,
  slot: string,
) {
  const encrypted = encryptSecret(
    JSON.stringify(value ?? null),
    JSON.stringify([tenant, execution, slot]),
  );
  return {
    $sensitive: true as const,
    ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
    iv: Buffer.from(encrypted.iv).toString("base64"),
    auth_tag: Buffer.from(encrypted.auth_tag).toString("base64"),
  };
}

export function recoverExecutionPayload(
  value: unknown,
  tenant: string,
  execution: string,
  slot = "input",
): unknown {
  if (!isSensitivePayload(value)) return value;
  const payload = SensitivePayloadSchema.parse(value);
  return JSON.parse(
    decryptSecret(
      {
        ciphertext: Buffer.from(payload.ciphertext, "base64"),
        iv: Buffer.from(payload.iv, "base64"),
        auth_tag: Buffer.from(payload.auth_tag, "base64"),
      },
      JSON.stringify([tenant, execution, slot]),
    ),
  );
}

const safeFailureCodes = new Set([
  "request_outside_declared_boundary",
  "execution_authority_changed",
  "execution_boundary_mismatch",
  "execution_authority_required",
  "execution_authority_unavailable",
  "authority_redirect_denied",
  "sensitive_resume_forbidden",
  "sensitive_execution_unsupported",
  "input_schema_violation",
  "invalid",
  "caller_required",
  "caller_tenant_mismatch",
  "caller_product_mismatch",
  "caller_kind_mismatch",
  "aborted",
  "timed_out",
]);

export function sensitiveFailure(code?: string) {
  return {
    code: code && safeFailureCodes.has(code) ? code : "sensitive_execution_failure",
    message: "Sensitive execution failed.",
  };
}

export async function authorizeSensitiveResume(
  db: import("../db/client.ts").Db,
  row: { tenant_id: string; caller_context: unknown },
  principal?: import("../auth/types.ts").ResolvedPrincipal | null,
  internal = false,
): Promise<void> {
  const { CallerContextSchema, callerFromPrincipal } = await import("./caller-context.ts");
  const { isDeepStrictEqual } = await import("node:util");
  const caller = row.caller_context ? CallerContextSchema.parse(row.caller_context) : null;
  if (
    !internal &&
    (!principal ||
      !caller ||
      !isDeepStrictEqual(
        caller,
        callerFromPrincipal(principal, row.tenant_id, caller.productId ?? undefined),
      ))
  ) {
    throw Object.assign(new Error("Sensitive resume requires the original authenticated caller."), {
      code: "sensitive_resume_forbidden",
    });
  }
  if (caller) {
    if (!z.string().uuid().safeParse(caller.principalId).success) {
      throw Object.assign(new Error("Sensitive resume requires an active internal principal."), {
        code: "sensitive_resume_forbidden",
      });
    }
    const { and, eq } = await import("drizzle-orm");
    const { users, systemAccounts } = await import("../db/schema/index.ts");
    const active =
      caller.principalKind === "user"
        ? (
            await db
              .select({ deleted_at: users.deleted_at, status: users.status })
              .from(users)
              .where(and(eq(users.tenant_id, row.tenant_id), eq(users.id, caller.principalId)))
              .limit(1)
          )[0]
        : (
            await db
              .select({ deleted_at: systemAccounts.deleted_at })
              .from(systemAccounts)
              .where(
                and(
                  eq(systemAccounts.tenant_id, row.tenant_id),
                  eq(systemAccounts.id, caller.principalId),
                ),
              )
              .limit(1)
          )[0];
    if (
      !active ||
      active.deleted_at !== null ||
      ("status" in active && active.status !== "active")
    ) {
      throw Object.assign(new Error("Sensitive resume caller is no longer active."), {
        code: "sensitive_resume_forbidden",
      });
    }
  }
}
