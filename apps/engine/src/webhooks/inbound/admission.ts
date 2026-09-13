import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { executions } from "../../db/schema/index.ts";
import { admitAuthorizedWorkflowExecution } from "../../execution/authority-admission.ts";
import { JsonValueSchema } from "../../workflows/types.ts";

const PayloadSchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.number().finite(),
    type: z.string(),
    headers: z.record(z.string(), z.string()),
    body: JsonValueSchema,
  })
  .strict();

function stablePayload(input: z.infer<typeof PayloadSchema>) {
  // Each retry is signature-verified first. Delivery proofs may be refreshed;
  // they never replace the immutable input of an already reserved execution.
  const headers = Object.fromEntries(
    Object.entries(input.headers).filter(
      ([key]) =>
        !["webhook-signature", "webhook-timestamp", "stripe-signature"].includes(key.toLowerCase()),
    ),
  );
  return { id: input.id, type: input.type, body: input.body, headers };
}

export async function admitWebhookExecution(
  db: Db,
  binding: { tenant_id: string; id: string; workflow_id: string },
  workflow_version_id: string,
  rawPayload: unknown,
) {
  const payload = PayloadSchema.parse(rawPayload);
  const eventDigest = createHash("sha256").update(payload.id).digest("hex");
  const idempotency_key = `webhook:${binding.id}:${eventDigest}`;
  return db.transaction(async (tx) => {
    // Match the admission service's lock so concurrent delivery retries compare
    // against the committed first input before reserving any additional run.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${binding.tenant_id}:${idempotency_key}`}, 0))`,
    );
    const [existing] = await tx
      .select({ input: executions.input })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, binding.tenant_id),
          eq(executions.idempotency_key, idempotency_key),
        ),
      )
      .limit(1);
    let input = payload;
    if (existing) {
      const original = PayloadSchema.safeParse(existing.input);
      if (
        !original.success ||
        !isDeepStrictEqual(stablePayload(original.data), stablePayload(payload))
      ) {
        throw Object.assign(
          new Error("the webhook event ID belongs to a different execution input"),
          {
            code: "execution_boundary_mismatch",
          },
        );
      }
      input = original.data;
    }
    return admitAuthorizedWorkflowExecution(
      {
        tenant_id: binding.tenant_id,
        workflow_id: binding.workflow_id,
        workflow_version_id,
        execution_environment: "prod",
        request_source: "webhook",
        idempotency_key,
        input,
      },
      tx,
    );
  });
}
