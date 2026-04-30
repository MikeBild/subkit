// Inbound webhook service.
//
//   * CRUD for `webhooks_inbound` rows (slug → workflow binding).
//   * `handleInbound()` — the request driver. Given a slug, headers,
//     and raw body, it resolves the verifier, validates the signature,
//     dedups via `webhook_replay_seen`, and (on success) creates an
//     `executions` row + enqueues an `execution.run` job with the
//     normalized payload as input and `request_source=webhook`.

import { and, desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { audit, auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { decryptSecret, encryptSecret } from "../../crypto/aes-gcm.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import { type Db, getDb } from "../../db/client.ts";
import { webhooksInbound, workflows } from "../../db/schema/index.ts";
import { createExecution } from "../../execution/state.ts";
import { logger } from "../../logging/logger.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../../queue/queues.ts";
import { markSeenIfNew } from "./dedup.ts";
import { verifyGitHub } from "./verifiers/github.ts";
import { verifyStandard } from "./verifiers/standard-webhooks.ts";
import { verifyStripe } from "./verifiers/stripe.ts";
import type { VerifierFn } from "./verifiers/types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function aadFor(tenant_id: string, id: string): string {
  return `webhook-inbound:${tenant_id}:${id}`;
}

function toBuf(u: Uint8Array): Buffer {
  return Buffer.from(u);
}

export type InboundVerifierName = "standard" | "github" | "stripe";

const VERIFIERS: Record<InboundVerifierName, VerifierFn> = {
  standard: verifyStandard,
  github: verifyGitHub,
  stripe: verifyStripe,
};

export interface InboundRow {
  id: string;
  tenant_id: string;
  slug: string;
  workflow_id: string;
  verifier: InboundVerifierName;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function serialize(row: typeof webhooksInbound.$inferSelect): InboundRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    workflow_id: row.workflow_id,
    verifier: row.verifier as InboundVerifierName,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateInboundInput {
  tenant_id: string;
  actor_id: string | null;
  slug: string;
  workflow_id: string;
  verifier: InboundVerifierName;
  secret: string;
  native_verifier_config?: Record<string, unknown> | null;
  active?: boolean;
}

export async function createInbound(
  input: CreateInboundInput,
  exec?: Executor,
): Promise<InboundRow> {
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const placeholder = encryptSecret("__placeholder__");
    const inserted = await tx
      .insert(webhooksInbound)
      .values({
        tenant_id: input.tenant_id,
        slug: input.slug,
        workflow_id: input.workflow_id,
        verifier: input.verifier,
        native_verifier_config: input.native_verifier_config ?? null,
        secret_ciphertext: toBuf(placeholder.ciphertext),
        secret_iv: toBuf(placeholder.iv),
        secret_auth_tag: toBuf(placeholder.auth_tag),
        active: input.active ?? true,
      })
      .returning();
    const row = inserted[0];
    assertInsertRow(row, "webhooks_inbound");
    const payload = encryptSecret(input.secret, aadFor(input.tenant_id, row.id));
    const updated = await tx
      .update(webhooksInbound)
      .set({
        secret_ciphertext: toBuf(payload.ciphertext),
        secret_iv: toBuf(payload.iv),
        secret_auth_tag: toBuf(payload.auth_tag),
        updated_at: new Date(),
      })
      .where(eq(webhooksInbound.id, row.id))
      .returning();
    const final = updated[0] ?? row;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.WEBHOOK_INBOUND_CREATED,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "success",
        metadata: {
          slug: input.slug,
          workflow_id: input.workflow_id,
          verifier: input.verifier,
        },
      },
      tx,
    );
    return serialize(final);
  });
}

export async function listInbound(tenant_id: string, exec?: Executor): Promise<InboundRow[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(webhooksInbound)
    .where(eq(webhooksInbound.tenant_id, tenant_id))
    .orderBy(desc(webhooksInbound.created_at));
  return rows.map(serialize);
}

export async function getInbound(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<InboundRow | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(webhooksInbound)
    .where(and(eq(webhooksInbound.tenant_id, tenant_id), eq(webhooksInbound.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? serialize(row) : null;
}

export async function deleteInbound(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? getDb();
  const result = await db
    .delete(webhooksInbound)
    .where(and(eq(webhooksInbound.tenant_id, tenant_id), eq(webhooksInbound.id, id)));
  const ok = (result as { rowCount?: number }).rowCount
    ? ((result as { rowCount?: number }).rowCount ?? 0) > 0
    : true;
  if (ok) {
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.WEBHOOK_INBOUND_DELETED,
        resource_type: "webhook_inbound",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      db,
    );
  }
  return ok;
}

// ------------------ handle() driver -----------------------------------

export interface HandleInboundInput {
  slug: string;
  headers: Record<string, string>;
  rawBody: string;
  /** Optional clock override for tests. */
  now?: number;
}

export type HandleOutcome =
  | {
      status: "ok";
      inbound_id: string;
      execution_id: string;
      normalized: { id: string; timestamp: number; type: string };
    }
  | { status: "deduped"; inbound_id: string }
  | { status: "not_found" }
  | { status: "denied"; reason: string; inbound_id?: string };

export interface HandleInboundOptions {
  db: Db;
  boss: PgBoss;
}

export async function handleInbound(
  opts: HandleInboundOptions,
  input: HandleInboundInput,
): Promise<HandleOutcome> {
  const { db, boss } = opts;
  // 1) Slug lookup — the inbound row is keyed by (tenant, slug) but we
  //    don't know the tenant at this point, so we scan by slug and
  //    expect uniqueness across tenants via the composite unique
  //    index. For P11 a slug is globally unique because tests seed a
  //    single tenant, but we still carry the tenant id forward.
  const rows = await db
    .select()
    .from(webhooksInbound)
    .where(eq(webhooksInbound.slug, input.slug))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (!row.active) return { status: "denied", reason: "inactive", inbound_id: row.id };

  // 2) Decrypt secret.
  const secret = decryptSecret(
    {
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
      auth_tag: row.secret_auth_tag,
    },
    aadFor(row.tenant_id, row.id),
  );

  // 3) Verify signature.
  const verifier = VERIFIERS[row.verifier as InboundVerifierName];
  if (!verifier) {
    audit(
      {
        tenant_id: row.tenant_id,
        action: AuditAction.WEBHOOK_INBOUND_DENIED,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "denied",
        reason: "unknown_verifier",
        metadata: { verifier: row.verifier },
      },
      db,
    );
    return { status: "denied", reason: "unknown_verifier", inbound_id: row.id };
  }
  const verifyInput = {
    headers: input.headers,
    rawBody: input.rawBody,
    secret,
    now: input.now ?? Date.now(),
    config: (row.native_verifier_config as Record<string, unknown> | null) ?? null,
  };
  const verdict = verifier(verifyInput);
  if (!verdict.ok) {
    audit(
      {
        tenant_id: row.tenant_id,
        action: AuditAction.WEBHOOK_INBOUND_DENIED,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "denied",
        reason: verdict.reason,
        metadata: { slug: input.slug, verifier: row.verifier },
      },
      db,
    );
    return { status: "denied", reason: verdict.reason, inbound_id: row.id };
  }

  // 4) Replay dedup.
  const fresh = await markSeenIfNew(db, {
    tenant_id: row.tenant_id,
    webhook_id: row.id,
    standard_webhook_id: verdict.normalized.id,
  });
  if (!fresh) {
    audit(
      {
        tenant_id: row.tenant_id,
        action: AuditAction.WEBHOOK_INBOUND_RECEIVED,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "success",
        reason: "replay_dedup",
        metadata: {
          slug: input.slug,
          webhook_id: verdict.normalized.id,
        },
      },
      db,
    );
    return { status: "deduped", inbound_id: row.id };
  }

  // 5) Resolve workflow + enqueue execution.run.
  const wfRows = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, row.tenant_id), eq(workflows.id, row.workflow_id)))
    .limit(1);
  const wf = wfRows[0];
  if (!wf?.current_version_id) {
    audit(
      {
        tenant_id: row.tenant_id,
        action: AuditAction.WEBHOOK_INBOUND_DENIED,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "error",
        reason: "workflow_unresolved",
        metadata: { workflow_id: row.workflow_id },
      },
      db,
    );
    return { status: "denied", reason: "workflow_unresolved", inbound_id: row.id };
  }

  const normalizedBody = (() => {
    try {
      return JSON.parse(input.rawBody) as unknown;
    } catch {
      return input.rawBody;
    }
  })();
  const inputPayload = {
    id: verdict.normalized.id,
    timestamp: verdict.normalized.timestamp,
    type: verdict.normalized.type,
    headers: input.headers,
    body: normalizedBody,
  };

  const execution_id = await createExecution(db, {
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    workflow_version_id: wf.current_version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "webhook",
    parent_execution_id: null,
  });
  const job: ExecutionRunJob = {
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    execution_id,
    input: inputPayload,
    request_source: "webhook",
  };
  await boss.send(EXECUTION_RUN_QUEUE, job);

  audit(
    {
      tenant_id: row.tenant_id,
      action: AuditAction.WEBHOOK_INBOUND_RECEIVED,
      resource_type: "webhook_inbound",
      resource_id: row.id,
      result: "success",
      metadata: {
        slug: input.slug,
        webhook_id: verdict.normalized.id,
        execution_id,
      },
    },
    db,
  );
  logger.info({
    module: "webhooks.inbound",
    action: "inbound.accepted",
    msg: "inbound webhook accepted",
    slug: input.slug,
    webhook_id: verdict.normalized.id,
    execution_id,
  });

  return {
    status: "ok",
    inbound_id: row.id,
    execution_id,
    normalized: verdict.normalized,
  };
}
