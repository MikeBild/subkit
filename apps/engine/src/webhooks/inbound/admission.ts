import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { executions } from "../../db/schema/index.ts";
import { admitSystemWorkflowExecution } from "../../execution/authority-admission.ts";
import { recoverExecutionPayload } from "../../execution/sensitive-payload.ts";
import { JsonValueSchema } from "../../workflows/types.ts";
import { HmacVerifierConfig } from "./verifiers/hmac.ts";

const PayloadSchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.number().finite(),
    type: z.string(),
    headers: z.record(z.string(), z.string()),
    body: JsonValueSchema,
  })
  .strict();

interface WebhookBinding {
  tenant_id: string;
  id: string;
  workflow_id: string;
  verifier?: string;
  native_verifier_config?: unknown;
}

export function stableWebhookPayload(
  input: z.infer<typeof PayloadSchema>,
  binding: WebhookBinding,
) {
  const transient = new Set(["webhook-signature", "webhook-timestamp", "stripe-signature"]);
  if (binding.verifier === "hmac") {
    const envelope = z
      .object({ hmac: HmacVerifierConfig })
      .safeParse(binding.native_verifier_config);
    const config = envelope.success ? envelope.data.hmac : null;
    if (config) {
      transient.add(config.signature_header);
      if (config.timestamp_header) transient.add(config.timestamp_header);
      if (config.id_field && config.id_header) transient.add(config.id_header);
    }
  }
  const headers = Object.fromEntries(
    Object.entries(input.headers).filter(([key]) => !transient.has(key.toLowerCase())),
  );
  return { id: input.id, type: input.type, body: input.body, headers };
}

export async function webhookReplayMatches(
  db: Db,
  binding: WebhookBinding,
  rawPayload: unknown,
): Promise<boolean> {
  const payload = PayloadSchema.parse(rawPayload);
  const eventDigest = createHash("sha256").update(payload.id).digest("hex");
  const [existing] = await db
    .select({ id: executions.id, input: executions.input })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, binding.tenant_id),
        eq(executions.idempotency_key, `webhook:${binding.id}:${eventDigest}`),
      ),
    )
    .limit(1);
  if (!existing) return false;
  try {
    const original = PayloadSchema.safeParse(
      recoverExecutionPayload(existing.input, binding.tenant_id, existing.id),
    );
    return (
      original.success &&
      isDeepStrictEqual(
        stableWebhookPayload(original.data, binding),
        stableWebhookPayload(payload, binding),
      )
    );
  } catch {
    return false;
  }
}

export async function admitWebhookExecution(
  db: Db,
  binding: WebhookBinding,
  workflow_version_id: string,
  rawPayload: unknown,
) {
  const payload = PayloadSchema.parse(rawPayload);
  const eventDigest = createHash("sha256").update(payload.id).digest("hex");
  const idempotency_key = `webhook:${binding.id}:${eventDigest}`;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${binding.tenant_id}:${idempotency_key}`}, 0))`,
    );
    const [existing] = await tx
      .select({ id: executions.id, input: executions.input })
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
      const original = PayloadSchema.safeParse(
        recoverExecutionPayload(existing.input, binding.tenant_id, existing.id),
      );
      if (
        !original.success ||
        !isDeepStrictEqual(
          stableWebhookPayload(original.data, binding),
          stableWebhookPayload(payload, binding),
        )
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
    return admitSystemWorkflowExecution(
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
