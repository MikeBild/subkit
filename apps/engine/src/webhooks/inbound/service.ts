import { type InboundOrigin, type InboundRow, type InboundVerifierName, serialize } from "./row.ts";

export type { InboundOrigin, InboundRow, InboundVerifierName } from "./row.ts";

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { type Actor, auditActor } from "../../audit/actor.ts";
import { audit, auditAwait } from "../../audit/audit.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { AuditAction, type AuditActorType } from "../../audit/types.ts";
import { decryptSecret, encryptSecret } from "../../crypto/aes-gcm.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import { type Db, type Executor, getDb } from "../../db/client.ts";
import { webhooksInbound, workflows } from "../../db/schema/index.ts";
import { assertExecutionAuthorityCurrent } from "../../execution/authority-admission.ts";
import { assertTenantActive, SelfServiceIdentityError } from "../../identity/self-service.ts";
import { logger } from "../../logging/logger.ts";
import { enqueueGateDiagnosis } from "../../queue/handlers/workflow-repair.ts";
import { enqueueHostedWork } from "../../queue/hosted-work.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../../queue/queues.ts";
import type { WebhookTrigger } from "../../workflows/types.ts";
import { admitWebhookExecution, webhookReplayMatches } from "./admission.ts";
import { type InboundHoldReason, recordInboundAdmission } from "./admission-state.ts";
import { markSeenIfNew, wasSeen } from "./dedup.ts";
import { verifyGitHub } from "./verifiers/github.ts";
import { HmacVerifierConfig, verifyHmac } from "./verifiers/hmac.ts";
import { verifyStandard } from "./verifiers/standard-webhooks.ts";
import { verifyStripe } from "./verifiers/stripe.ts";
import type { VerifierFn, VerifierResult } from "./verifiers/types.ts";

function aadFor(tenant_id: string, id: string): string {
  return `webhook-inbound:${tenant_id}:${id}`;
}

function toBuf(u: Uint8Array): Buffer {
  return Buffer.from(u);
}

const VERIFIERS: Record<InboundVerifierName, VerifierFn> = {
  standard: verifyStandard,
  github: verifyGitHub,
  stripe: verifyStripe,
  hmac: verifyHmac,
};

const ACCEPTED_VERIFIERS = Object.keys(VERIFIERS) as InboundVerifierName[];

export interface CreateInboundInput {
  tenant_id: string;
  actor_id: string | null;
  actor?: Actor | null;
  actor_type?: import("../../audit/types.ts").AuditActorType;
  slug: string;
  workflow_id: string;
  verifier: InboundVerifierName;
  secret: string;
  native_verifier_config?: Record<string, unknown> | null;
  active?: boolean;
}

export const INBOUND_SLUG_MAX_LENGTH = 64;

const INBOUND_SLUG_INDEX = "webhooks_inbound_slug_key";

const INBOUND_SLUG_CLAIM_ATTEMPTS = 50;

export class InboundSlugTakenError extends Error {
  readonly code = "inbound_slug_taken";

  constructor(readonly slug: string) {
    super(`inbound hook slug "${slug}" is already in use`);
  }
}

export function isInboundSlugTaken(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      message?: string;
      cause?: unknown;
    };
    const named = e.constraint ?? e.constraint_name ?? "";
    if (
      e.code === "23505" &&
      (named === INBOUND_SLUG_INDEX || (e.message ?? "").includes(INBOUND_SLUG_INDEX))
    )
      return true;
    cur = e.cause;
  }
  return false;
}

export async function createInbound(
  input: CreateInboundInput,
  exec?: Executor,
): Promise<InboundRow> {
  try {
    return await insertInbound(input, exec);
  } catch (err) {
    if (isInboundSlugTaken(err)) throw new InboundSlugTakenError(input.slug);
    throw err;
  }
}

async function insertInbound(input: CreateInboundInput, exec?: Executor): Promise<InboundRow> {
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
        ...(input.actor ? auditActor(input.actor) : resolveActor(input)),
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
  actor_input: string | Actor | null,
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
        ...(typeof actor_input === "string"
          ? resolveActor({ tenant_id, actor_id: actor_input })
          : actor_input
            ? auditActor(actor_input)
            : resolveActor({ tenant_id, actor_id: null })),
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

const VERIFY_TO_VERIFIER: Record<WebhookTrigger["verify"], InboundVerifierName> = {
  "stripe-signature": "stripe",
  "github-hmac": "github",
  none: "standard",
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function slugFromWorkflow(wfSlug: string): string {
  return `wf-${wfSlug}`.slice(0, INBOUND_SLUG_MAX_LENGTH);
}

function tenantSlugMark(tenant_id: string): string {
  return createHash("md5").update(tenant_id).digest("hex").slice(0, 6);
}

function withSlugSuffix(slug: string, suffix: string): string {
  return `${slug.slice(0, INBOUND_SLUG_MAX_LENGTH - suffix.length - 1)}-${suffix}`;
}

export function inboundSlugCandidate(desired: string, tenant_id: string, attempt: number): string {
  if (attempt === 0) return desired;
  const marked = withSlugSuffix(desired, tenantSlugMark(tenant_id));
  return attempt === 1 ? marked : withSlugSuffix(marked, String(attempt));
}

function isInboundSlugCandidate(slug: string, desired: string, tenant_id: string): boolean {
  if (slug === desired) return true;
  const marked = inboundSlugCandidate(desired, tenant_id, 1);
  if (slug === marked) return true;
  const counter = /-([2-9]|[1-9]\d+)$/.exec(slug)?.[1];
  return counter !== undefined && withSlugSuffix(marked, counter) === slug;
}

async function inboundSlugInUse(exec: Executor, slug: string): Promise<boolean> {
  // tenant-filter:exempt — a hook slug is a public path shared by all tenants; only whether it is taken is read, never the holder
  const rows = await exec
    .select({ id: webhooksInbound.id })
    .from(webhooksInbound)
    .where(eq(webhooksInbound.slug, slug))
    .limit(1);
  return rows.length > 0;
}

async function claimInboundSlug<T>(
  exec: Executor,
  desired: string,
  tenant_id: string,
  write: (slug: string) => Promise<T | null>,
): Promise<{ slug: string; written: T }> {
  for (let attempt = 0; attempt < INBOUND_SLUG_CLAIM_ATTEMPTS; attempt += 1) {
    const slug = inboundSlugCandidate(desired, tenant_id, attempt);
    if (await inboundSlugInUse(exec, slug)) continue;
    const written = await write(slug);
    if (written !== null) return { slug, written };
  }
  throw new InboundSlugTakenError(desired);
}

export interface BindFromWorkflowInput {
  tenant_id: string;
  workflow_id: string;
  workflow_slug: string;
  trigger: WebhookTrigger;
  actor_id: string | null;
  actor?: Actor | null;
  actor_type?: import("../../audit/types.ts").AuditActorType;
}

export type BindFromWorkflowOutcome =
  | { status: "created"; row: InboundRow }
  | { status: "updated"; row: InboundRow }
  | { status: "noop"; row: InboundRow };

export async function bindFromWorkflow(
  input: BindFromWorkflowInput,
  exec?: Executor,
): Promise<BindFromWorkflowOutcome> {
  const db = exec ?? getDb();
  const verifier = VERIFY_TO_VERIFIER[input.trigger.verify];
  const desiredSlug = slugFromWorkflow(input.workflow_slug);
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
      const keepsSlug = isInboundSlugCandidate(prior.slug, desiredSlug, input.tenant_id);
      const sameVerifier = prior.verifier === verifier;
      const samePayload =
        canonicalJson(prior.native_verifier_config ?? {}) === canonicalJson(nativeConfig);
      if (keepsSlug && sameVerifier && samePayload) {
        return { status: "noop", row: serialize(prior) } as const;
      }
      const rebind = (target: Executor, nextSlug: string) =>
        target
          .update(webhooksInbound)
          .set({
            slug: nextSlug,
            verifier,
            native_verifier_config: nativeConfig,
            updated_at: new Date(),
          })
          .where(
            and(eq(webhooksInbound.tenant_id, input.tenant_id), eq(webhooksInbound.id, prior.id)),
          )
          .returning();
      const claimed = keepsSlug
        ? { slug: prior.slug, written: await rebind(tx, prior.slug) }
        : await claimInboundSlug(tx, desiredSlug, input.tenant_id, async (nextSlug) => {
            try {
              return await tx.transaction(async (savepoint) => await rebind(savepoint, nextSlug));
            } catch (err) {
              if (isInboundSlugTaken(err)) return null;
              throw err;
            }
          });
      const slug = claimed.slug;
      const final = claimed.written[0] ?? prior;
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...(input.actor ? auditActor(input.actor) : resolveActor(input)),
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

    const placeholderSecret = randomBytes(32).toString("hex");
    const placeholder = encryptSecret(placeholderSecret);
    const { slug, written: row } = await claimInboundSlug(
      tx,
      desiredSlug,
      input.tenant_id,
      async (nextSlug) => {
        const inserted = await tx
          .insert(webhooksInbound)
          .values({
            tenant_id: input.tenant_id,
            slug: nextSlug,
            workflow_id: input.workflow_id,
            verifier,
            native_verifier_config: nativeConfig,
            secret_ciphertext: toBuf(placeholder.ciphertext),
            secret_iv: toBuf(placeholder.iv),
            secret_auth_tag: toBuf(placeholder.auth_tag),
            active: true,
            origin: "trigger",
          })
          .onConflictDoNothing({ target: webhooksInbound.slug })
          .returning();
        return inserted[0] ?? null;
      },
    );
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
        ...(input.actor ? auditActor(input.actor) : resolveActor(input)),
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

export async function unbindFromWorkflow(
  tenant_id: string,
  workflow_id: string,
  actor_input: string | Actor | { actor_id: string | null; actor_type?: AuditActorType } | null,
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
          ...(typeof actor_input === "string"
            ? resolveActor({ tenant_id, actor_id: actor_input })
            : actor_input && "kind" in actor_input
              ? auditActor(actor_input)
              : resolveActor({
                  tenant_id,
                  actor_id: actor_input?.actor_id ?? null,
                  ...(actor_input?.actor_type !== undefined
                    ? { actor_type: actor_input.actor_type }
                    : {}),
                })),
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

export interface HandleInboundInput {
  slug: string;
  headers: Record<string, string>;
  rawBody: string;
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

async function holdInboundAdmission(
  db: Db,
  row: { tenant_id: string; id: string; workflow_id: string },
  now: number | undefined,
  reason: InboundHoldReason | null,
  gate?: { boss: PgBoss; version_id: string },
): Promise<void> {
  try {
    const changed = await recordInboundAdmission(
      db,
      { tenant_id: row.tenant_id, inbound_id: row.id, observed_at: new Date(now ?? Date.now()) },
      reason,
    );
    if (changed && reason && gate)
      await enqueueGateDiagnosis(gate.boss, db, {
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        version_id: gate.version_id,
        environment: "prod",
        source: "inbound_hook",
      });
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
  // tenant-filter:exempt — a public hook path names no tenant; webhooks_inbound_slug_key makes the slug resolve to at most one hook
  const rows = await db
    .select()
    .from(webhooksInbound)
    .where(eq(webhooksInbound.slug, input.slug))
    .limit(2);
  if (rows.length > 1) {
    logger.error({
      module: "webhooks",
      action: "inbound.slug_ambiguous",
      msg: "an inbound hook slug resolved to more than one hook; the delivery was refused",
      slug: input.slug,
    });
    return { status: "not_found" };
  }
  const row = rows[0];
  if (!row) return { status: "not_found" };
  try {
    await assertTenantActive(row.tenant_id, db);
  } catch (err) {
    if (!(err instanceof SelfServiceIdentityError)) throw err;
    return { status: "not_found" };
  }
  const origin: InboundOrigin = (row.origin as InboundOrigin | undefined) ?? "crud";
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

  const verifier = VERIFIERS[row.verifier as InboundVerifierName];
  if (!verifier) {
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

  let verdict: VerifierResult;
  if (config?.skip === true) {
    verdict = skipVerify(input);
  } else {
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

  const seen = await wasSeen(db, {
    tenant_id: row.tenant_id,
    webhook_id: row.id,
    standard_webhook_id: verdict.normalized.id,
  });
  if (seen) {
    const hmac = row.verifier === "hmac" ? HmacVerifierConfig.safeParse(config?.hmac) : null;
    if (
      (row.verifier === "standard" || (hmac?.success && hmac.data.id_field)) &&
      !(await webhookReplayMatches(db, row, {
        id: verdict.normalized.id,
        timestamp: verdict.normalized.timestamp,
        type: verdict.normalized.type,
        headers: input.headers,
        body: JSON.parse(input.rawBody),
      }))
    ) {
      audit(
        {
          tenant_id: row.tenant_id,
          action: FAILED_ACTION,
          resource_type: "webhook_inbound",
          resource_id: row.id,
          result: "denied",
          reason: "execution_boundary_mismatch",
          metadata: { ...baseAuditMetadata, event_id: verdict.normalized.id },
        },
        db,
      );
      return { status: "denied", reason: "execution_boundary_mismatch", inbound_id: row.id };
    }
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
      await holdInboundAdmission(db, row, input.now, code, {
        boss,
        version_id: wf.current_version_id,
      });
    return { status: "denied", reason: code, inbound_id: row.id, hint };
  }
  const execution_id = admitted.execution_id;
  const job: ExecutionRunJob = {
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    execution_id,
    request_source: "webhook",
    execution_mode: "prod",
  };
  if (admitted.status === "queued") {
    await enqueueHostedWork(db, boss, "execution", EXECUTION_RUN_QUEUE, job, { id: execution_id });
    await holdInboundAdmission(db, row, input.now, null);
  }
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
