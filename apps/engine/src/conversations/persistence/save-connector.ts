// Atomic connector + credential save — extracted from
// `tools/save-connector-draft.ts` so both the LLM-driven tool path AND
// the harness-driven auto-persist path (PR11/PR12 — elicitation
// `commit_intent`) share one durability contract.
//
// One-place rule: any change to the upsert sequence (connector first →
// conversation target update → optional credential → endpoint analysis
// → draft snapshot transition) lives here. The tool wrapper and the
// elicitation auto-persist dispatcher are thin callers.

import { eq } from "drizzle-orm";
import {
  recordConnectorCreated,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
} from "../../audit/recorders/index.ts";
import { createConnector, getConnector } from "../../connectors/service.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { upsertCredential } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { analyzeConversationAttachments } from "../../llm/flows/analyze-conversation-attachments.ts";
import { logger } from "../../logging/logger.ts";
import { withConnectorPersisted, withConnectorValidation } from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
import {
  buildGateError,
  buildPersistencePayload,
  missingFreshCheckpoints,
} from "../tools/authoring-contract.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import { clearDraftCredential } from "./draft-credential-cache.ts";

/** Shape of the optional credential collected via `ask_user_form(type:password)`. */
export type AtomicCredentialInput =
  | { mode: "bearer"; token: string }
  | { mode: "basic"; username: string; password: string }
  | { mode: "header"; header_name: string; header_value: string }
  | { mode: "query"; param: string; value: string };

export interface SaveConnectorAtomicParams {
  ctx: ToolContext;
  environment: "dev" | "prod";
  credential?: AtomicCredentialInput | undefined;
  /**
   * When true, persist the connector even if the most recent probe
   * failed. Operator-confirmed escape hatch; matches the
   * `force_save` arg on the tool wrapper. Defaults to false — a
   * failed probe + missing force_save returns a structured
   * `probe_failed` envelope so the LLM can re-issue with the user's
   * blessing.
   */
  forceSave?: boolean;
  /**
   * Reason annotation surfaced as the audit row's `reason` column. The
   * tool path leaves it null (the existing `connector.created` audit
   * shape stays untouched); the harness auto-persist path passes
   * `auto_persist_on_confirmation` so operators can distinguish a
   * harness-issued save from an LLM-issued one.
   */
  reason?: string;
  /**
   * When true, emit a secondary `connector.persisted` audit row tagged
   * with `commit_intent_kind`. Used by the harness auto-persist path so
   * the audit trail records which elicitation kind drove the write.
   */
  emitAutoPersistAudit?: boolean;
  /** Used by the auto-persist audit row only. */
  commitIntentKind?: string;
}

/**
 * Atomic connector + (optional) credential save. Mirrors the previous
 * tool body line-for-line so behaviour stays identical:
 *
 *   1. Idempotency check against `connector.saved_connector_id`.
 *   2. Validate the draft against `validateConnectorDraft`.
 *   3. Gate on missing-fresh checkpoints + driver-required probe.
 *   4. `createConnector` → conversations.target_connector_id update →
 *      attachment-driven endpoint analysis (best-effort) → optional
 *      `upsertCredential`.
 *   5. Snapshot the draft into `connector_persisted` lifecycle.
 *
 * Returns the same `ToolResult` envelope the tool wrapper has always
 * surfaced, so wrapper + harness can share the downstream
 * `data`/`pause`/`committed_workflow_id` plumbing without touching it.
 */
export async function saveConnectorAtomic(p: SaveConnectorAtomicParams): Promise<ToolResult> {
  const { ctx } = p;
  const draft = ctx.getDraft();
  const connector = draft.connector;

  // Idempotency: re-issued path returns the existing connector +
  // optionally refreshes the credential. See save-connector-draft.ts
  // history for the original 2ee4511c symptom.
  const existingSavedId = connector?.saved_connector_id ?? null;
  if (existingSavedId) {
    const existing = await getConnector(ctx.tenant_id, existingSavedId, ctx.db);
    if (existing) {
      let credential_persisted = false;
      if (p.credential) {
        await persistCredential({
          tenant_id: ctx.tenant_id,
          connector_id: existing.id,
          environment: p.environment,
          actor_id: ctx.actor_id,
          credential: p.credential,
          db: ctx.db as Db,
        });
        credential_persisted = true;
      }
      // Idempotent save still graduates the credential to the encrypted
      // table — drop any leftover in-memory draft credential so a
      // subsequent probe doesn't keep using the cached value.
      clearDraftCredential(ctx.conversation_id);
      if (p.emitAutoPersistAudit) {
        await recordConnectorUpdated({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          executor: ctx.db,
          connector_id: existing.id,
          kind: "auto_persist_idempotent",
          reason: p.reason ?? "auto_persist_on_confirmation",
          source: "harness_auto_persist",
          environment: existing.environment,
          credential_persisted,
          idempotent: true,
          ...(p.commitIntentKind ? { commit_intent_kind: p.commitIntentKind } : {}),
        });
      }
      return {
        ok: true,
        data: {
          ...buildPersistencePayload(draft, {
            resource_kind: "connector",
            resource_id: existing.id,
          }),
          connector: {
            id: existing.id,
            slug: existing.slug,
            display_name: existing.display_name,
            environment: existing.environment,
            driver: existing.driver,
          },
          idempotent: true,
          credential_persisted,
        },
      };
    }
  }

  const templates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
  const validation = validateConnectorDraft(
    connector ?? null,
    templates.map((entry) => entry.template),
  );
  if (!connector) {
    return {
      ok: false,
      data: buildGateError(draft, {
        error_code: "connector_missing",
        message: "start a connector draft before saving it",
        recommended_mode: "connector",
      }),
    };
  }
  if (!validation.ok) {
    const nextDraft = withConnectorValidation(
      draft,
      { ...connector, validation },
      false,
      "Connector draft is invalid and cannot be persisted yet.",
      "connector_save_blocked",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: false,
      data: buildGateError(nextDraft, {
        error_code: "validation_failed",
        message: "connector draft is invalid",
        stale_checkpoints: ["connector_validated"],
        recommended_mode: "connector",
        extra: { validation },
      }),
    };
  }
  const staleCheckpoints = missingFreshCheckpoints(draft, [
    "connector_inspected",
    "connector_validated",
  ]);
  const requiresProbe =
    connector.driver === "http" ||
    connector.driver === "graphql" ||
    connector.driver === "postgres" ||
    connector.driver === "s3";
  const requiresCredential =
    connector.auth_type !== undefined &&
    connector.auth_type !== null &&
    connector.auth_type !== "none";
  const blocking_reasons = [
    ...(draft.summary?.blocked_by ?? []).filter(
      (reason) =>
        reason === "inspect_connector_draft" ||
        reason === "validate_connector_draft" ||
        reason.startsWith("missing:"),
    ),
  ];
  // Stale-checkpoint / missing-field gate is non-overridable — those
  // reflect "the draft itself is incomplete", which `force_save` was
  // never intended to bypass.
  if (
    staleCheckpoints.length > 0 ||
    blocking_reasons.some((reason) => reason.startsWith("missing:"))
  ) {
    return {
      ok: false,
      error_code: "connector_not_ready",
      message: "connector save is blocked until inspection and validation are fresh",
      next_best_actions: ["inspect_connector_draft", "validate_connector_draft"],
      data: buildGateError(draft, {
        error_code: "connector_not_ready",
        message: "connector save is blocked until inspection and validation are fresh",
        stale_checkpoints: staleCheckpoints,
        blocking_reasons,
        recommended_mode: "connector",
        next_best_actions: ["inspect_connector_draft", "validate_connector_draft"],
        extra: {
          validation,
          latest_probe: connector.latest_probe ?? null,
        },
      }),
    };
  }

  // Credential gate — a connector with an auth requirement cannot be
  // persisted without a credential. The masked
  // `ask_user_form(type:password)` path collects the secret and feeds
  // it into `p.credential`; if neither this call nor a prior one
  // supplied one, surface the structured `credential_required`
  // envelope so the LLM can re-issue with `ask_user_form` instead of
  // silently failing.
  if (requiresCredential && !p.credential) {
    return {
      ok: false,
      error_code: "credential_required",
      message: `connector "${connector.name ?? connector.slug ?? "draft"}" needs a ${connector.auth_type} credential before it can be persisted`,
      next_best_actions: ["ask_user_form"],
      data: buildGateError(draft, {
        error_code: "credential_required",
        message: `connector save needs a ${connector.auth_type} credential — collect it via ask_user_form(type: password) and resubmit`,
        recommended_mode: "connector",
        next_best_actions: ["ask_user_form"],
        extra: {
          auth_type: connector.auth_type,
          latest_probe: connector.latest_probe ?? null,
        },
      }),
    };
  }

  // Probe gate — for drivers that support a probe, a failed-or-missing
  // probe blocks the save UNLESS the operator explicitly forces it
  // (force_save: true). The envelope's `next_best_actions` lists the
  // recovery routes so the LLM can decide to re-probe, rotate the
  // credential, or escalate to a force_save.
  const probeFailed = requiresProbe && connector.latest_probe?.ok !== true;
  if (probeFailed && p.forceSave !== true) {
    const hasProbeRecord = connector.latest_probe != null;
    return {
      ok: false,
      error_code: hasProbeRecord ? "probe_failed" : "connector_not_ready",
      message: hasProbeRecord
        ? "the most recent probe was unsuccessful — re-probe successfully, rotate the credential, or call save_connector_draft again with force_save: true after the operator explicitly confirms"
        : "probe the connector draft successfully before saving it",
      next_best_actions: hasProbeRecord
        ? ["probe_connector_draft", "ask_user_form", "save_connector_draft"]
        : ["probe_connector_draft", "ask_user_form"],
      ...(connector.latest_probe ? { details: connector.latest_probe } : {}),
      data: buildGateError(draft, {
        error_code: hasProbeRecord ? "probe_failed" : "connector_not_ready",
        message: hasProbeRecord
          ? "probe failed — re-probe, rotate the credential via ask_user_form, or call save_connector_draft again with force_save: true after the operator explicitly confirms"
          : "probe the connector draft successfully before saving it",
        stale_checkpoints: hasProbeRecord ? [] : ["connector_probed"],
        recommended_mode: "connector",
        next_best_actions: hasProbeRecord
          ? ["probe_connector_draft", "ask_user_form", "save_connector_draft"]
          : ["probe_connector_draft", "ask_user_form"],
        extra: {
          latest_probe: connector.latest_probe ?? null,
          force_save_available: hasProbeRecord,
        },
      }),
    };
  }
  const saved = await createConnector(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      input: toCreateConnectorInput(connector),
    },
    ctx.db,
  );
  await ctx.db
    .update(conversations)
    .set({
      target_connector_id: saved.id,
      updated_at: new Date(),
    })
    .where(eq(conversations.id, ctx.conversation_id));

  // Attachment-driven endpoint extraction. Best-effort; failures here
  // never block the save.
  let analysis: { source_format: string; confidence: number; endpoint_count: number } | null = null;
  try {
    const result = await analyzeConversationAttachments({
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      db: ctx.db,
      connector_id: saved.id,
    });
    if (result) {
      analysis = {
        source_format: result.source_format,
        confidence: result.confidence,
        endpoint_count: result.endpoints.length,
      };
    }
  } catch (err) {
    logger.warn({
      module: "save-connector-atomic",
      action: "document_analysis_failed",
      tenant_id: ctx.tenant_id,
      connector_id: saved.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let credential_persisted = false;
  if (p.credential) {
    await persistCredential({
      tenant_id: ctx.tenant_id,
      connector_id: saved.id,
      environment: p.environment,
      actor_id: ctx.actor_id,
      credential: p.credential,
      db: ctx.db as Db,
    });
    credential_persisted = true;
  }
  // The connector now has a real UUID and (if applicable) an encrypted
  // credential row. Drop the in-memory draft credential so subsequent
  // probes go through the canonical `getCredentialForConnector` path.
  clearDraftCredential(ctx.conversation_id);

  if (p.emitAutoPersistAudit) {
    await recordConnectorCreated({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      executor: ctx.db,
      connector_id: saved.id,
      slug: saved.slug,
      driver: saved.driver,
      environment: saved.environment,
      reason: p.reason ?? "auto_persist_on_confirmation",
      source: "harness_auto_persist",
      credential_persisted,
      ...(p.commitIntentKind ? { commit_intent_kind: p.commitIntentKind } : {}),
    });
  }

  // Force-save audit annotation — every probe-overridden save lands a
  // distinct `connector.saved_override` row so operators can see exactly
  // which connectors were persisted without a green probe and why.
  if (p.forceSave === true && requiresProbe && connector.latest_probe?.ok !== true) {
    await recordConnectorSavedOverride({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      executor: ctx.db,
      connector_id: saved.id,
      slug: saved.slug,
      driver: saved.driver,
      environment: saved.environment,
      reason: p.reason ?? "force_save_override",
      latest_probe: connector.latest_probe ?? null,
      source: p.emitAutoPersistAudit ? "harness_auto_persist" : "tool_call",
    });
  }

  const nextDraft = withConnectorPersisted(
    draft,
    {
      ...connector,
      validation,
      saved_connector_id: saved.id,
    },
    {
      kind: "connector",
      id: saved.id,
      slug: saved.slug,
      name: saved.display_name,
      version_id: null,
      version: null,
      environment: saved.environment,
      saved_at: new Date().toISOString(),
    },
    "connector_saved",
  );
  await ctx.setDraft(nextDraft);
  return {
    ok: true,
    data: {
      ...buildPersistencePayload(nextDraft, {
        resource_kind: "connector",
        resource_id: saved.id,
      }),
      connector: {
        id: saved.id,
        slug: saved.slug,
        display_name: saved.display_name,
        environment: saved.environment,
        driver: saved.driver,
      },
      ...(credential_persisted ? { credential_persisted: true } : {}),
      ...(analysis ? { document_analysis: analysis } : {}),
    },
  };
}

async function persistCredential(p: {
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  actor_id: string | null;
  credential: AtomicCredentialInput;
  db: Db;
}): Promise<void> {
  const cred = p.credential;
  const value =
    cred.mode === "bearer"
      ? { mode: "bearer" as const, token: cred.token }
      : cred.mode === "basic"
        ? { mode: "basic" as const, username: cred.username, password: cred.password }
        : cred.mode === "header"
          ? { mode: "header" as const, headers: { [cred.header_name]: cred.header_value } }
          : { mode: "query" as const, query: { [cred.param]: cred.value } };
  await upsertCredential(
    {
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      environment: p.environment,
      mode: cred.mode,
      value,
      actor_id: p.actor_id,
    },
    p.db,
  );
}
