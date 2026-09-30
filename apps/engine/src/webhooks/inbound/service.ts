// Inbound webhook service.
//
//   * CRUD for `webhooks_inbound` rows (slug → workflow binding).
//   * `handleInbound()` — the request driver. Given a slug, headers,
//     and raw body, it resolves the verifier, validates the signature,
//     dedups via `webhook_replay_seen`, and (on success) creates an
//     `executions` row + enqueues an `execution.run` job with the
//     normalized payload as input and `request_source=webhook`.

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { audit, auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { decryptSecret, encryptSecret } from "../../crypto/aes-gcm.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import { type Db, type Executor, getDb } from "../../db/client.ts";
import { webhooksInbound, workflows } from "../../db/schema/index.ts";
import { assertExecutionAuthorityCurrent } from "../../execution/authority-admission.ts";
import { logger } from "../../logging/logger.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../../queue/queues.ts";
import type { WebhookTrigger } from "../../workflows/types.ts";
import { admitWebhookExecution } from "./admission.ts";
import { type InboundHoldReason, recordInboundAdmission } from "./admission-state.ts";
import { markSeenIfNew, wasSeen } from "./dedup.ts";
import { verifyGitHub } from "./verifiers/github.ts";
import { verifyStandard } from "./verifiers/standard-webhooks.ts";
import { verifyStripe } from "./verifiers/stripe.ts";
import type { VerifierFn, VerifierResult } from "./verifiers/types.ts";

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

/** Accepted values for the stored `verifier` column. Used to build an
 *  actionable denial when a row carries an unrecognised verifier.
 *  Note: `none`/`skip`/`insecure` are NOT stored verifiers — the
 *  trigger-level `verify: "none"` reverse-binds to `standard` with
 *  `native_verifier_config.skip = true` (see VERIFY_TO_VERIFIER). */
const ACCEPTED_VERIFIERS = Object.keys(VERIFIERS) as InboundVerifierName[];

/** Provenance marker — `crud` for rows created via the authenticated
 *  HTTP CRUD surface, `trigger` for rows reverse-bound by a workflow
 *  with a `webhook` trigger. The fire-time audit surface uses this
 *  to decide whether to emit the workflow-trigger actions
 *  (`webhook.trigger.fired` / `webhook.trigger.failed_verification`)
 *  or the legacy direct-CRUD actions. */
export type InboundOrigin = "crud" | "trigger";

export interface InboundRow {
  id: string;
  tenant_id: string;
  slug: string;
  workflow_id: string;
  verifier: InboundVerifierName;
  active: boolean;
  origin: InboundOrigin;
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
    origin: (row.origin as InboundOrigin | undefined) ?? "crud",
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
        origin: "crud",
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
// missing signature; the executor wires `skip` through.

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
        origin: "trigger",
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
 * Rotate the signing secret on an existing inbound row in place.
 *
 * The reverse-bind helper writes a random placeholder secret on first
 * bind because the signing secret is not carried on the workflow
 * trigger — operators provision it out-of-band. This helper is the
 * out-of-band entry point: it encrypts the new plaintext with the
 * row-scoped AAD and stamps `updated_at`. Returns true when a row
 * was updated.
 */
export async function rotateInboundSecret(
  tenant_id: string,
  inbound_id: string,
  secret: string,
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? getDb();
  const payload = encryptSecret(secret, aadFor(tenant_id, inbound_id));
  const result = await db
    .update(webhooksInbound)
    .set({
      secret_ciphertext: toBuf(payload.ciphertext),
      secret_iv: toBuf(payload.iv),
      secret_auth_tag: toBuf(payload.auth_tag),
      updated_at: new Date(),
    })
    .where(and(eq(webhooksInbound.tenant_id, tenant_id), eq(webhooksInbound.id, inbound_id)));
  const rowCount = (result as { rowCount?: number }).rowCount;
  return rowCount === undefined ? true : rowCount > 0;
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
  | { status: "denied"; reason: string; inbound_id?: string; hint?: string };

export interface HandleInboundOptions {
  db: Db;
  boss: PgBoss;
}

/** Standing admission state is a projection of the delivery just answered:
 *  failing to record it must not turn that answer into a 500. */
async function holdInboundAdmission(
  db: Db,
  row: { tenant_id: string; id: string },
  now: number | undefined,
  reason: InboundHoldReason | null,
): Promise<void> {
  try {
    await recordInboundAdmission(
      db,
      { tenant_id: row.tenant_id, inbound_id: row.id, observed_at: new Date(now ?? Date.now()) },
      reason,
    );
  } catch (err) {
    logger.warn({
      module: "webhooks",
      action: "inbound.admission_state_failed",
      msg: "could not record the hook's admission state; the delivery was answered regardless",
      tenant_id: row.tenant_id,
      inbound_id: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  // tenant-filter:exempt — slug-based routing pre-tenant; (slug) is globally unique
  const rows = await db
    .select()
    .from(webhooksInbound)
    .where(eq(webhooksInbound.slug, input.slug))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "not_found" };
  const origin: InboundOrigin = (row.origin as InboundOrigin | undefined) ?? "crud";
  // Audit-action routing — `trigger`-origin rows emit the workflow-
  // trigger lifecycle actions; `crud`-origin rows keep the legacy
  // direct-CRUD actions. Both surfaces are append-only, both fire on
  // the same code paths; the action label is the only thing that
  // changes. Compliance dashboards filter on action so the split is
  // load-bearing.
  const FIRED_ACTION =
    origin === "trigger" ? AuditAction.WEBHOOK_TRIGGER_FIRED : AuditAction.WEBHOOK_INBOUND_RECEIVED;
  const FAILED_ACTION =
    origin === "trigger"
      ? AuditAction.WEBHOOK_TRIGGER_FAILED_VERIFICATION
      : AuditAction.WEBHOOK_INBOUND_DENIED;
  const baseAuditMetadata = {
    origin,
    slug: input.slug,
    workflow_id: row.workflow_id,
  };
  if (!row.active) {
    // Inactive bindings are a denial. Trigger-origin rows surface a
    // `failed_verification` audit so compliance dashboards see the
    // attempt; crud-origin rows preserve the historical "silent
    // denial" behaviour (no audit row written for inactive CRUD rows)
    // so we don't change the contract on the existing surface.
    if (origin === "trigger") {
      audit(
        {
          tenant_id: row.tenant_id,
          action: FAILED_ACTION,
          resource_type: "webhook_inbound",
          resource_id: row.id,
          result: "denied",
          reason: "inactive",
          metadata: baseAuditMetadata,
        },
        db,
      );
    }
    return { status: "denied", reason: "inactive", inbound_id: row.id };
  }

  // 2) Resolve verifier. Done BEFORE touching the stored secret so an
  //    unrecognised verifier fails fast with an actionable denial
  //    rather than a decrypt.
  const verifier = VERIFIERS[row.verifier as InboundVerifierName];
  if (!verifier) {
    // A stored `verifier` outside {standard, github, stripe} is almost
    // always a hand-written / legacy row that put the trigger-level
    // token (`none`/`skip`) into the column. Spell out the fix instead
    // of returning a bare "unknown_verifier": `verify: "none"` is not a
    // stored verifier — it reverse-binds to `standard` + skip.
    const hint =
      `stored verifier "${String(row.verifier)}" is not recognised — accepted values are ` +
      `${ACCEPTED_VERIFIERS.join(", ")}. A trigger-level verify:"none" is NOT a stored ` +
      `verifier: it reverse-binds to verifier="standard" with ` +
      `native_verifier_config.skip=true. Re-save the workflow trigger (or recreate the ` +
      `binding) so the row stores a valid verifier.`;
    audit(
      {
        tenant_id: row.tenant_id,
        action: FAILED_ACTION,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "denied",
        reason: "unknown_verifier",
        metadata: {
          ...baseAuditMetadata,
          verifier: row.verifier,
          accepted_verifiers: ACCEPTED_VERIFIERS,
          hint,
        },
      },
      db,
    );
    return { status: "denied", reason: "unknown_verifier", inbound_id: row.id, hint };
  }
  const config = (row.native_verifier_config as Record<string, unknown> | null) ?? null;

  // 3) Verify signature.
  //
  // Decryption is LAZY. When `native_verifier_config.skip === true`
  // (the `verify: "none"` mapping) the operator declared the ingress
  // trusted (intra-VPC, mTLS-fronted) and the signature check is
  // bypassed entirely — so we must NOT decrypt the stored secret at
  // all. Trigger reverse-bind writes a random placeholder secret on
  // first bind and an operator may never rotate a real one onto a skip
  // binding; eagerly decrypting a malformed/placeholder ciphertext
  // would surface a `CryptoError` (e.g. "iv length N, expected 12") as
  // an HTTP 500 on an otherwise-acceptable request. We only decrypt
  // inside the branch where a real verifier runs. On the skip path we
  // still synthesise a stable normalized.id for the replay-dedup table.
  let verdict: VerifierResult;
  if (config?.skip === true) {
    verdict = skipVerify(input);
  } else {
    // A row whose stored envelope cannot decrypt (legacy/hand-written
    // secret, wrong AAD, truncated iv) must deny like any other failed
    // verification — the caller sent an unverifiable request. Letting
    // the CryptoError escape turns a bad *stored row* into an HTTP 500
    // on the public ingress and hides the actionable fix (rotate the
    // secret) from the operator.
    let secret: string;
    try {
      secret = decryptSecret(
        {
          ciphertext: row.secret_ciphertext,
          iv: row.secret_iv,
          auth_tag: row.secret_auth_tag,
        },
        aadFor(row.tenant_id, row.id),
      );
    } catch (err) {
      const hint =
        "the stored signing secret for this binding cannot be decrypted — rotate it " +
        "(rotateInboundSecret / re-save the workflow trigger) or, if the sender does not " +
        'sign requests, set the trigger to verify:"none"';
      logger.warn({
        module: "webhooks",
        action: "inbound.secret_undecryptable",
        inbound_id: row.id,
        tenant_id: row.tenant_id,
        slug: row.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      audit(
        {
          tenant_id: row.tenant_id,
          action: FAILED_ACTION,
          resource_type: "webhook_inbound",
          resource_id: row.id,
          result: "denied",
          reason: "secret_undecryptable",
          metadata: { ...baseAuditMetadata, verifier: row.verifier, hint },
        },
        db,
      );
      return { status: "denied", reason: "secret_undecryptable", inbound_id: row.id, hint };
    }
    verdict = verifier({
      headers: input.headers,
      rawBody: input.rawBody,
      secret,
      now: input.now ?? Date.now(),
      config,
    });
  }
  if (!verdict.ok) {
    audit(
      {
        tenant_id: row.tenant_id,
        action: FAILED_ACTION,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "denied",
        reason: verdict.reason,
        metadata: { ...baseAuditMetadata, verifier: row.verifier },
      },
      db,
    );
    return { status: "denied", reason: verdict.reason, inbound_id: row.id };
  }

  // 3b) Optional event-name filter declared on the trigger binding.
  // `bindFromWorkflow` writes `{ source, events: [...] }` into
  // `native_verifier_config`. An empty `events` list is "any" — the
  // discriminator on a webhook-trigger workflow can omit `events`, in
  // which case it defaults to `[]` from Zod and accepts everything.
  const events = Array.isArray(config?.events) ? (config?.events as string[]) : null;
  if (events && events.length > 0 && !events.includes(verdict.normalized.type)) {
    audit(
      {
        tenant_id: row.tenant_id,
        action: FAILED_ACTION,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "denied",
        reason: "event_not_subscribed",
        metadata: {
          ...baseAuditMetadata,
          event_id: verdict.normalized.id,
          event_type: verdict.normalized.type,
          accepted_events: events,
        },
      },
      db,
    );
    return { status: "denied", reason: "event_not_subscribed", inbound_id: row.id };
  }

  // 4) Replay dedup.
  const seen = await wasSeen(db, {
    tenant_id: row.tenant_id,
    webhook_id: row.id,
    standard_webhook_id: verdict.normalized.id,
  });
  if (seen) {
    // Replay rejection. Trigger-origin treats this as a verification
    // failure (the event already fired once — this attempt is
    // redundant). Crud-origin keeps the historical "received +
    // replay_dedup reason" semantic so existing dashboards built on
    // `webhook.inbound.received` still see the row.
    if (origin === "trigger") {
      audit(
        {
          tenant_id: row.tenant_id,
          action: FAILED_ACTION,
          resource_type: "webhook_inbound",
          resource_id: row.id,
          result: "denied",
          reason: "replay_dedup",
          metadata: {
            ...baseAuditMetadata,
            event_id: verdict.normalized.id,
          },
        },
        db,
      );
    } else {
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
    }
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
        action: FAILED_ACTION,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "error",
        reason: "workflow_unresolved",
        metadata: { ...baseAuditMetadata },
      },
      db,
    );
    return { status: "denied", reason: "workflow_unresolved", inbound_id: row.id };
  }
  // Fire-time lifecycle guard, mirroring the schedule reconciler's
  // deleted_at / archived filter. Archive now unbinds inbound rows, but
  // rows bound before that cleanup existed (or hand-written ones) must
  // still never trigger an archived or soft-deleted workflow.
  if (wf.deleted_at !== null || wf.lifecycle === "archived") {
    audit(
      {
        tenant_id: row.tenant_id,
        action: FAILED_ACTION,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "denied",
        reason: "workflow_inactive",
        metadata: {
          ...baseAuditMetadata,
          lifecycle: wf.lifecycle,
          deleted: wf.deleted_at !== null,
        },
      },
      db,
    );
    return { status: "denied", reason: "workflow_inactive", inbound_id: row.id };
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

  let admitted: Awaited<ReturnType<typeof admitWebhookExecution>>;
  try {
    admitted = await admitWebhookExecution(db, row, wf.current_version_id, inputPayload);
    if (admitted.status === "queued")
      await assertExecutionAuthorityCurrent(db, row.tenant_id, admitted.execution_id);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (
      ![
        "execution_authority_required",
        "execution_authority_unavailable",
        "execution_authority_changed",
        "execution_boundary_mismatch",
        "workflow_version_not_active",
        "input_schema_violation",
      ].includes(code)
    )
      throw error;
    const hint =
      "Review the exact active workflow version, production effect boundary and finite execution authority in the workflow Cockpit before retrying. A webhook signature does not grant execution authority.";
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        action: FAILED_ACTION,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "denied",
        reason: code,
        metadata: { ...baseAuditMetadata, event_id: verdict.normalized.id, hint },
      },
      db,
    );
    if (code === "execution_authority_required" || code === "execution_authority_unavailable")
      await holdInboundAdmission(db, row, input.now, code);
    return { status: "denied", reason: code, inbound_id: row.id, hint };
  }
  const execution_id = admitted.execution_id;
  const job: ExecutionRunJob = {
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    execution_id,
    input: admitted.input,
    request_source: "webhook",
    // Unattended deliveries use only an explicitly reviewed production authority.
    execution_mode: "prod",
  };
  if (admitted.status === "queued") {
    await boss.send(EXECUTION_RUN_QUEUE, job, { id: execution_id });
    await holdInboundAdmission(db, row, input.now, null);
  }
  // Mark only after durable enqueue. A failed send leaves the same reservation
  // retryable; a lost response reuses the job UUID, never a second charged run.
  const fresh = await markSeenIfNew(db, {
    tenant_id: row.tenant_id,
    webhook_id: row.id,
    standard_webhook_id: verdict.normalized.id,
  });
  if (!fresh || admitted.status !== "queued") return { status: "deduped", inbound_id: row.id };

  if (origin === "trigger") {
    audit(
      {
        tenant_id: row.tenant_id,
        action: FIRED_ACTION,
        resource_type: "webhook_inbound",
        resource_id: row.id,
        result: "success",
        metadata: {
          ...baseAuditMetadata,
          event_id: verdict.normalized.id,
          event_type: verdict.normalized.type,
          execution_id,
        },
      },
      db,
    );
  } else {
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
  }
  logger.info({
    module: "webhooks.inbound",
    action: "inbound.accepted",
    msg: "inbound webhook accepted",
    slug: input.slug,
    origin,
    webhook_id: verdict.normalized.id,
    event_type: verdict.normalized.type,
    execution_id,
  });

  return {
    status: "ok",
    inbound_id: row.id,
    execution_id,
    normalized: verdict.normalized,
  };
}

// `verify: "none"` short-circuit. Synthesise a normalized event from
// optional headers (`webhook-id`, `webhook-timestamp`, `webhook-type`)
// or fall back to a body-derived hash so replay-dedup still works.
function skipVerify(input: HandleInboundInput): VerifierResult {
  const id =
    input.headers["webhook-id"] ??
    `skip-${createHash("sha256").update(input.rawBody).digest("hex").slice(0, 32)}`;
  const tsHeader = input.headers["webhook-timestamp"];
  const tsParsed = tsHeader ? Number.parseInt(tsHeader, 10) : Number.NaN;
  const timestamp = Number.isFinite(tsParsed)
    ? tsParsed
    : Math.floor((input.now ?? Date.now()) / 1000);
  const type = input.headers["webhook-type"] ?? "unknown";
  return { ok: true, normalized: { id, timestamp, type } };
}
