import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import type { InputSchemaVerdict } from "./core/admission.ts";
import { validateAgainstJsonSchema } from "./engine/envelope.ts";

export async function lockIdempotentExecution(
  tx: Executor,
  tenant_id: string,
  idempotency_key: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant_id}:${idempotency_key}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(executions)
    .where(
      and(eq(executions.tenant_id, tenant_id), eq(executions.idempotency_key, idempotency_key)),
    )
    .limit(1);
  return existing ?? null;
}

export function inputSchemaVerdict(
  input: unknown,
  schema: Record<string, unknown> | null | undefined,
): InputSchemaVerdict {
  if (!schema) return { valid: true };
  const check = validateAgainstJsonSchema(input, schema, "$input");
  return check.valid ? { valid: true } : { valid: false, errors: check.errors };
}
