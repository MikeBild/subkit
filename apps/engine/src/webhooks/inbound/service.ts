// Inbound webhook service.
//
//   * CRUD for `webhooks_inbound` rows (slug → workflow binding).
//   * `handleInbound()` — the request driver. Given a slug, headers,
//     and raw body, it resolves the verifier, validates the signature,
//     dedups via `webhook_replay_seen`, and (on success) creates an
//     `executions` row + enqueues an `execution.run` job with the
//     normalized payload as input and `request_source=webhook`.

import { randomBytes } from "node:crypto";
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
import type { WebhookTrigger } from "../../workflows/types.ts";
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

// ------------------ workflow trigger reverse-bind ---------------------
//
// Workflow lifecycle (`apps/engine/src/workflows/service.ts`) calls
// these helpers when a workflow is saved or deleted with a
// `trigger: { kind: "webhook" }` block. The contract is intentionally
// idempotent on `(tenant_id, workflow_id)`:
//
//   * `bindFromWorkflow` upserts a single inbound row per workflow.
//     The slug is derived from the workflow's slug so the public
//     ingress URL stays stable across edits. The signing secret is
//     NOT carried on the trigger — operators provision the secret
//     out-of-band via the existing CRUD route. On first bind the
//     helper writes a random placeholder ciphertext so the row's
//     NOT-NULL constraints stay satisfied; subsequent binds preserve
//     the secret already on the row.
//
//   * `unbindFromWorkflow` deletes the row. Both helpers emit
//     `WEBHOOK_TRIGGER_BOUND` / `WEBHOOK_TRIGGER_UNBOUND` audit
//     entries; the older `WEBHOOK_INBOUND_CREATED` /
//     `WEBHOOK_INBOUND_DELETED` actions stay reserved for direct
//     CRUD via the HTTP API.
//
// Verifier mapping mirrors the trigger discriminator:
//
//   "stripe-signature" → "stripe"
//   "github-hmac"      → "github"
//   "none"             → "standard" with native_verifier_config = { skip: true }
//
// The "none" mapping reuses the standard-webhooks verifier as a
// pass-through so the inbound driver never has to special-case the
// missing signature; the executor PR (#46) wires `skip` through.

const VERIFY_TO_VERIFIER: Record<WebhookTrigger["verify"], InboundVerifierName> = {
  "stripe-signature": "stripe",
  "github-hmac": "github",
  none: "standard",
};

// Postgres jsonb returns object keys in storage order (length, then
// lex), not insertion order — round-tripping `native_verifier_config`
// breaks naive JSON.stringify equality even when values match.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function slugFromWorkflow(wfSlug: string): string {
  // Stable, idempotent — we never want a workflow rename to leak a
  // secondary inbound row. Length-bounded to keep below the
  // historical 64-char slug ceiling.
  return `wf-${wfSlug}`.slice(0, 64);
}

export interface BindFromWorkflowInput {
  tenant_id: string;
  workflow_id: string;
  /** The workflow's slug, used to derive the inbound public slug. */
  workflow_slug: string;
  trigger: WebhookTrigger;
  actor_id: string | null;
}

export type BindFromWorkflowOutcome =
  | { status: "created"; row: InboundRow }
  | { status: "updated"; row: InboundRow }
  | { status: "noop"; row: InboundRow };

/**
 * Reverse-bind helper called from the workflow save path. Idempotent
 * on `(tenant_id, workflow_id)` — repeated calls with the same
 * trigger are no-ops; mutating any of `verifier`, `slug`, or
 * `native_verifier_config` rewrites the row in place.
 */
export async function bindFromWorkflow(
  input: BindFromWorkflowInput,
  exec?: Executor,
): Promise<BindFromWorkflowOutcome> {
  const db = exec ?? getDb();
  const verifier = VERIFY_TO_VERIFIER[input.trigger.verify];
  const slug = slugFromWorkflow(input.workflow_slug);
  const nativeConfig: Record<string, unknown> = {
    source: input.trigger.source,
    events: input.trigger.events,
  };
  if (input.trigger.verify === "none") nativeConfig.skip = true;

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, input.tenant_id),
          eq(webhooksInbound.workflow_id, input.workflow_id),
        ),
      )
      .limit(1);
    const prior = existing[0];

    if (prior) {
      const sameSlug = prior.slug === slug;
      const sameVerifier = prior.verifier === verifier;
      const samePayload =
        canonicalJson(prior.native_verifier_config ?? {}) === canonicalJson(nativeConfig);
      if (sameSlug && sameVerifier && samePayload) {
        return { status: "noop", row: serialize(prior) } as const;
      }
      const updated = await tx
        .update(webhooksInbound)
        .set({
          slug,
          verifier,
          native_verifier_config: nativeConfig,
          updated_at: new Date(),
        })
        .where(eq(webhooksInbound.id, prior.id))
        .returning();
      const final = updated[0] ?? prior;
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          actor_type: input.actor_id ? "user" : "system",
          actor_id: input.actor_id,
          action: AuditAction.WEBHOOK_TRIGGER_BOUND,
          resource_type: "webhook_inbound",
          resource_id: final.id,
          result: "success",
          metadata: {
            slug,
            workflow_id: input.workflow_id,
            verifier,
            source: input.trigger.source,
            events: input.trigger.events,
            kind: "update",
          },
        },
        tx,
      );
      return { status: "updated", row: serialize(final) } as const;
    }

    // First bind — provision a random placeholder secret. The operator
    // rotates the real secret in via the existing PATCH/CREATE flow.
    const placeholderSecret = randomBytes(32).toString("hex");
    const placeholder = encryptSecret(placeholderSecret);
    const inserted = await tx
      .insert(webhooksInbound)
      .values({
        tenant_id: input.tenant_id,
        slug,
        workflow_id: input.workflow_id,
        verifier,
        native_verifier_config: nativeConfig,
        secret_ciphertext: toBuf(placeholder.ciphertext),
        secret_iv: toBuf(placeholder.iv),
        secret_auth_tag: toBuf(placeholder.auth_tag),
        active: true,
      })
      .returning();
    const row = inserted[0];
    assertInsertRow(row, "webhooks_inbound");
    // Re-encrypt the placeholder with the row-scoped AAD so it matches
    // the format `decryptSecret` expects on the read path.
    const aadBound = encryptSecret(placeholderSecret, aadFor(input.tenant_id, row.id));
    const finalRows = await tx
      .update(webhooksInbound)
      .set({
        secret_ciphertext: toBuf(aadBound.ciphertext),
        secret_iv: toBuf(aadBound.iv),
        secret_auth_tag: toBuf(aadBound.auth_tag),
        updated_at: new Date(),
      })
      .where(eq(webhooksInbound.id, row.id))
      .returning();
    const final = finalRows[0] ?? row;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.WEBHOOK_TRIGGER_BOUND,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "success",
        metadata: {
          slug,
          workflow_id: input.workflow_id,
          verifier,
          source: input.trigger.source,
          events: input.trigger.events,
          kind: "create",
          placeholder_secret: true,
        },
      },
      tx,
    );
    return { status: "created", row: serialize(final) } as const;
  });
}

/**
 * Reverse-unbind helper called from the workflow delete / version
 * rotate path. Removes every inbound binding for the workflow within
 * the tenant scope and emits one `WEBHOOK_TRIGGER_UNBOUND` audit row
 * per removed binding. Returns the number of rows removed (zero is a
 * legitimate outcome — workflows without webhook triggers never had
 * a binding to remove).
 */
export async function unbindFromWorkflow(
  tenant_id: string,
  workflow_id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<number> {
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const rows = await tx
      .delete(webhooksInbound)
      .where(
        and(eq(webhooksInbound.tenant_id, tenant_id), eq(webhooksInbound.workflow_id, workflow_id)),
      )
      .returning({ id: webhooksInbound.id, slug: webhooksInbound.slug });
    for (const row of rows) {
      await auditAwait(
        {
          tenant_id,
          actor_type: actor_id ? "user" : "system",
          actor_id,
          action: AuditAction.WEBHOOK_TRIGGER_UNBOUND,
          resource_type: "webhook_inbound",
          resource_id: row.id,
          result: "success",
          metadata: { slug: row.slug, workflow_id },
        },
        tx,
      );
    }
    return rows.length;
  });
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
