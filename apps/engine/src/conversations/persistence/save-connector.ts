// Atomic connector + credential save — extracted from
// `tools/save-connector-draft.ts` so both the LLM-driven tool path AND
// the harness-driven auto-persist path (via the elicitation
// `commit_intent`) share one durability contract.
//
// One-place rule: any change to the upsert sequence (connector first →
// conversation target update → optional credential → endpoint analysis
// → draft snapshot transition) lives here. The tool wrapper and the
// elicitation auto-persist dispatcher are thin callers.

import { eq } from "drizzle-orm";
import {
  recordConnectorCreated,
  recordConnectorDiscovered,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
} from "../../audit/recorders/index.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import { clearConnectorReauth } from "../../connectors/reauth.ts";
import { createConnector, getConnector, updateConnector } from "../../connectors/service.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import type { ConnectorView, UpdateConnectorInput } from "../../connectors/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { analyzeConversationAttachments } from "../../llm/flows/analyze-conversation-attachments.ts";
import { logger } from "../../logging/logger.ts";
import { now } from "../../utils/clock.ts";
import {
  withConnectorAuthenticated,
  withConnectorPersisted,
  withConnectorValidation,
} from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
import {
  buildGateError,
  buildPersistencePayload,
  missingFreshCheckpoints,
} from "../tools/authoring-contract.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import { connectorPersistEnvelopeFields } from "../tools/usage-guidance.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import { credentialModeMatchesAuthType } from "./credential-form-contract.ts";
import { clearDraftCredential, getDraftCredential } from "./draft-credential-cache.ts";
import { persistCredential } from "./persist-credential.ts";

/**
 * Connector-column edits a re-issued draft carries vs. the persisted row.
 *
 * Used by both `saveConnectorAtomic` and the `save_connector_draft` tool's
 * idempotency check so they agree on what counts as "changed". `config`
 * is deliberately excluded: the persisted config carries template
 * enrichment the draft never mirrors, so a diff there is unreliable —
 * explicit config edits go through the `update_connector` tool.
 */
export function connectorFieldPatch(
  connector: ConnectorDraftDocument | null | undefined,
  existing: ConnectorView,
): UpdateConnectorInput {
  const patch: UpdateConnectorInput = {};
  if (!connector) return patch;
  if (connector.base_url !== undefined && connector.base_url !== (existing.base_url ?? undefined)) {
    patch.base_url = connector.base_url;
  }
  if (connector.dsn !== undefined && connector.dsn !== (existing.dsn ?? undefined)) {
    patch.dsn = connector.dsn;
  }
  if (connector.name !== undefined && connector.name !== existing.display_name) {
    patch.name = connector.name;
  }
  if (connector.auth_type !== undefined && connector.auth_type !== existing.auth_type) {
    patch.auth_type = connector.auth_type;
  }
  return patch;
}

/**
 * Cooldown window after a failed probe during which `force_save: true`
 * is refused. Picked to be long enough that the LLM's "re-probe with
 * the same broken credential, then force_save" loop is broken, short
 * enough that legitimate operator workflows (rotate-then-save) don't
 * sit and wait. Tuned at one minute — a probe + manual operator confirm
 * comfortably fits inside this window so the cooldown only ever
 * triggers on the bad pattern.
 */
const FORCE_SAVE_COOLDOWN_MS = 60_000;

/** Shape of the optional credential collected via `ask_user_form(type:password)`.
 *
 *  `cognito_user_password` is the bootstrap shape: the operator hands us
 *  a Cognito email + password; the engine exchanges them at
 *  `cognito-idp.<region>.amazonaws.com` for an IdToken + RefreshToken
 *  before any probe runs. The persisted credential row ends up as
 *  `mode: "oauth2"` with `token_type: "none"` so the raw JWT lands in
 *  the `Authorization` header (AppSync rejects anything with a `Bearer`
 *  prefix). Refresh-on-stale uses `REFRESH_TOKEN_AUTH` against the
 *  same endpoint via `runCognitoRefreshTokenGrant`.
 *
 *  `aws_sigv4` is also a bootstrap shape — keys are persisted verbatim;
 *  signing happens per-request inside the HTTP driver's
 *  `executePlannedHttpRequest`.
 */
export type AtomicCredentialInput =
  | { mode: "bearer"; token: string }
  | { mode: "basic"; username: string; password: string }
  | { mode: "header"; header_name: string; header_value: string }
  | { mode: "query"; param: string; value: string }
  | {
      mode: "cognito_user_password";
      username: string;
      password: string;
      /** Override the `aws_region` from connector config when present. */
      aws_region?: string;
      /** Override the `client_id` from `oauth.client_id` when present. */
      client_id?: string;
      /** Optional Cognito app-client secret (apps with secret enabled). */
      client_secret?: string;
      /** Send AccessToken instead of IdToken (resource APIs that want
       *  the access scope). Defaults to IdToken (AppSync convention). */
      use_access_token?: boolean;
    }
  | {
      mode: "aws_sigv4";
      access_key_id: string;
      secret_access_key: string;
      session_token?: string;
    }
  | {
      /** OAuth2 client-credentials seed. NOT a credential-row write —
       *  the saved connector's `config.oauth` is updated so a subsequent
       *  `authenticate_oauth` call can run the dance. The credential
       *  row is created later by the OAuth callback route. */
      mode: "oauth2";
      client_id: string;
      client_secret?: string;
      token_endpoint?: string;
      authorization_endpoint?: string;
      scopes?: string;
    };

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
   * True ONLY when `forceSave` arrived through a RESOLVED operator
   * approval — the commit-intent dispatch from an approved elicitation
   * (`maybeAutoPersistFromElicitation`). That approval IS the human
   * override the fresh-probe cooldown exists to demand, so it bypasses
   * the cooldown; the override audit row records
   * `cooldown_bypassed: true`. A bare LLM-initiated `force_save`
   * (the `save_connector_draft` tool path) never sets this and keeps
   * the cooldown refusal.
   */
  forceSaveApproved?: boolean;
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
  /**
   * Suppress the fire-and-forget post-save discovery warm-up. Set by the
   * green-probe auto-persist path: the probe already proved the endpoint
   * live and the conversation continues immediately — an untracked
   * background introspection there outlives the tool call. Explicit saves
   * keep the warm-up; discovery stays available on demand via
   * `discover_connector_endpoints`.
   */
  skipBackgroundDiscovery?: boolean;
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

  // Re-issued path: the draft is already bound to a saved connector.
  // It refreshes the credential AND persists any connector-column edits
  // the operator made after the first save. Before 5.1.x this path
  // compared only the credential and silently dropped every field
  // change, so a `base_url` correction (the AppSync `/graphql` case)
  // could never land — `save_connector_draft` kept reporting
  // `already_persisted`. See save-connector-draft.ts history (2ee4511c).
  const existingSavedId = connector?.saved_connector_id ?? null;
  if (existingSavedId) {
    const existing = await getConnector(ctx.tenant_id, existingSavedId, ctx.db);
    if (existing) {
      // Patch whatever connector columns the draft changed since the
      // first save (most commonly a `base_url` correction).
      const fieldPatch = connectorFieldPatch(connector, existing);
      const updatedFields = Object.keys(fieldPatch);
      const fieldsChanged = updatedFields.length > 0;
      if (fieldsChanged) {
        // A field edit must still clear the draft validation gate. The
        // re-issue path skips the validation block below, so re-run it
        // here — this is what refuses a `base_url` patch that no longer
        // matches the template endpoint pattern (the AppSync host-root
        // trim), instead of persisting a connector that 404s every call.
        const templates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
        const validation = validateConnectorDraft(
          connector ?? null,
          templates.map((entry) => entry.template),
        );
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
            }),
          };
        }
        // `updateConnector` runs the UPDATE in its own transaction and
        // emits the `connector.updated` audit row with before/after.
        await updateConnector(ctx.tenant_id, existing.id, fieldPatch, ctx.actor_id, ctx.db);
      }

      // Write-sequence contract: persistCredential → clearConnectorReauth →
      // recordConnectorUpdated run as separate statements on `ctx.db`, NOT a
      // single transaction. A wrapping `ctx.db.transaction(...)` is
      // deliberately NOT used: `upsertCredential` (via persistCredential)
      // already opens its OWN transaction (credentials/service.ts), so an
      // outer transaction would nest — not cleanly supported by the executor
      // abstraction here, and the same pattern the pre-existing connector-save
      // path uses. The failure mode is benign and self-healing — if a later
      // step throws after the credential lands, the worst case is
      // `needs_reauth` stays true (the next authed call clears it via
      // clearConnectorReauth) and/or the connector-side credential_rotated
      // audit row is missing. There is never a partial credential write.
      let credential_persisted = false;
      if (p.credential) {
        await persistCredential({
          tenant_id: ctx.tenant_id,
          connector_id: existing.id,
          environment: p.environment,
          actor_id: ctx.actor_id,
          credential: p.credential,
          connectorConfig: (existing.config ?? {}) as Record<string, unknown>,
          db: ctx.db as Db,
        });
        credential_persisted = true;
      }
      // Re-save still graduates the credential to the encrypted table —
      // drop any leftover in-memory draft credential so a subsequent
      // probe doesn't keep using the cached value.
      clearDraftCredential(ctx.conversation_id);
      // A fresh credential just landed on a connector that may have been
      // flagged `needs_reauth` (the repair flow). Clear the flag + failure
      // provenance so the connector reads healthy immediately, rather than
      // waiting for the next live authed call. Gate on `credential_persisted`
      // so a pure field-edit re-issue (no new secret) never falsely clears a
      // genuinely-dead credential's flag. `clearConnectorReauth` self-audits
      // the true→false transition (CONNECTOR_REAUTH_CLEARED), so the state
      // change carries its own audit row independent of the credential_rotated
      // row below; pass actor_id so it attributes to the operator.
      if (credential_persisted) {
        await clearConnectorReauth(ctx.db, ctx.tenant_id, existing.id, {
          actor_id: ctx.actor_id,
        });
      }
      if (p.emitAutoPersistAudit) {
        await recordConnectorUpdated({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          executor: ctx.db,
          connector_id: existing.id,
          // A rotated credential is auditably distinct from a field edit —
          // surface `credential_rotated` so the audit trail names the secret
          // change (parity with the save_connector_draft re-issue audit).
          kind: credential_persisted
            ? "credential_rotated"
            : fieldsChanged
              ? "field_edit"
              : "auto_persist_idempotent",
          reason: p.reason ?? "auto_persist_on_confirmation",
          source: "harness_auto_persist",
          environment: existing.environment,
          credential_persisted,
          idempotent: !fieldsChanged && !credential_persisted,
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
          ...connectorPersistEnvelopeFields({
            id: existing.id,
            slug: existing.slug,
            display_name: fieldPatch.name ?? existing.display_name,
            environment: existing.environment,
            driver: existing.driver,
          }),
          idempotent: !fieldsChanged,
          ...(fieldsChanged ? { fields_updated: updatedFields } : {}),
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
  const staleCheckpointsRaw = missingFreshCheckpoints(draft, [
    "connector_inspected",
    "connector_validated",
  ]);
  // A FRESH GREEN probe supersedes stale inspect/validate checkpoints:
  // the probe exercised the real endpoint with the real credential —
  // strictly stronger evidence than the static checks this gate fronts.
  // Pre-fix, the green-probe auto-persist failed `connector_not_ready`
  // (×29 in one production authoring session) because probing never
  // refreshes the inspect/validate checkpoints, so a connector that had
  // just PROVEN itself live could not be saved.
  const probeCheckpointFresh = missingFreshCheckpoints(draft, ["connector_probed"]).length === 0;
  const probeIsGreen = connector.latest_probe?.ok === true;
  const staleCheckpoints = probeCheckpointFresh && probeIsGreen ? [] : staleCheckpointsRaw;
  // OAuth2 drafts cannot probe before `authenticate_oauth` completes —
  // there is no access token yet, every probe will 401. The documented
  // lifecycle is save → authenticate_oauth → probe (docs/05-connectors.md),
  // so the first save MUST not gate on probe; subsequent saves take the
  // idempotent short-circuit above. Before this carve-out OAuth2 drafts
  // tripped the probe gate, then the 60s `force_save` cooldown — the
  // Gmail-OAuth2 catch-22 from session 37a6d350 (2026-05-12).
  const requiresProbe =
    connector.auth_type !== "oauth2" &&
    (connector.driver === "http" ||
      connector.driver === "graphql" ||
      connector.driver === "postgres" ||
      connector.driver === "s3");
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
  //
  // Cache fallback: an LLM-issued `save_connector_draft` retry has no
  // secret to inline (the secret only ever flows through the masked
  // form). Honour the same in-memory draft credential cache that
  // `probe_connector_draft` reads so the operator does not get bounced
  // through `ask_user_form` a second time. Only accept a cached
  // credential whose mode matches the connector's `auth_type`.
  let credential = p.credential;
  if (requiresCredential && !credential) {
    const cached = getDraftCredential(ctx.conversation_id);
    if (cached && credentialModeMatchesAuthType(cached.mode, connector.auth_type ?? ""))
      credential = cached;
  }
  if (requiresCredential && !credential) {
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
  // Cooldown: even `force_save: true` is refused when the failed probe
  // is fresh (within 60s). Without this gate the LLM can persist the
  // exact credential a probe just rejected — every subsequent execution
  // then 401s and the operator chases their own tail (conversation
  // 730c568a). Stale failed probes still bypass via force_save: true so
  // operators can save credentials for systems they cannot probe right
  // now (intermittent endpoints, blocked egress, etc.).
  //
  // Missing-probed_at carve-out: a failed probe without a `probed_at`
  // timestamp is either a legacy persisted draft (pre-cfdbceb) or a
  // hand-built one. Treat it as fresh-and-failed and refuse force_save
  // — silently bypassing the cooldown for null-probed_at would leave
  // the LLM able to save a freshly-rejected credential.
  let cooldownBypassed = false;
  if (probeFailed && p.forceSave === true && connector.latest_probe) {
    const probedAtRaw = connector.latest_probe.probed_at;
    const probedAtMs = probedAtRaw ? Date.parse(probedAtRaw) : Number.NaN;
    const haveTimestamp = Number.isFinite(probedAtMs);
    // Clamp a future-dated probe (clock skew) to age 0: a negative age must
    // count as inside-cooldown, not bypass it — otherwise skew lets the LLM
    // force-save the exact credential a probe just rejected.
    const ageMs = haveTimestamp ? Math.max(0, now() - probedAtMs) : 0;
    const insideCooldown = haveTimestamp && ageMs < FORCE_SAVE_COOLDOWN_MS;
    if ((!haveTimestamp || insideCooldown) && p.forceSaveApproved === true) {
      // A resolved operator approval beats the cooldown — the cooldown
      // exists to stop the LLM force-saving a just-rejected credential
      // on its own, not to overrule an explicit human "save it anyway"
      // (conversation 68b5c87e: the operator approved the force-save and
      // the engine still refused with "probe failed ~40s ago").
      cooldownBypassed = true;
      logger.info({
        module: "conversation_persistence",
        action: "save_connector.force_save_cooldown_bypassed",
        msg: "fresh-probe force_save cooldown bypassed by resolved operator approval",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        probe_age_ms: haveTimestamp ? ageMs : null,
        probe_failure_code: connector.latest_probe.failure_code ?? null,
      });
    } else if (!haveTimestamp || insideCooldown) {
      const remainingMs = haveTimestamp ? FORCE_SAVE_COOLDOWN_MS - ageMs : FORCE_SAVE_COOLDOWN_MS;
      const message = haveTimestamp
        ? `the most recent probe failed ${Math.round(ageMs / 1000)}s ago — re-probe with the rotated credential before force-saving (cooldown: ${Math.round(remainingMs / 1000)}s remaining)`
        : `the most recent probe failed without a timestamp — re-probe with the current credential before force-saving (cooldown: ${Math.round(remainingMs / 1000)}s)`;
      return {
        ok: false,
        error_code: "force_save_cooldown",
        message,
        next_best_actions: ["ask_user_form", "probe_connector_draft", "save_connector_draft"],
        ...(connector.latest_probe ? { details: connector.latest_probe } : {}),
        data: buildGateError(draft, {
          error_code: "force_save_cooldown",
          message:
            "force_save is refused while the failed probe is still fresh — collect a new credential via ask_user_form, re-probe, then save",
          recommended_mode: "connector",
          next_best_actions: ["ask_user_form", "probe_connector_draft", "save_connector_draft"],
          extra: {
            latest_probe: connector.latest_probe ?? null,
            cooldown_ms: FORCE_SAVE_COOLDOWN_MS,
            probe_age_ms: haveTimestamp ? ageMs : null,
            cooldown_remaining_ms: remainingMs,
          },
        }),
      };
    }
  }
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
      updated_at: new Date(now()),
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
  if (credential) {
    await persistCredential({
      tenant_id: ctx.tenant_id,
      connector_id: saved.id,
      environment: p.environment,
      actor_id: ctx.actor_id,
      credential,
      connectorConfig: (saved.config ?? {}) as Record<string, unknown>,
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

  // GraphQL connectors: kick off introspection-based discovery in the
  // background so the LLM has the full schema available the next turn.
  // Pre-fix the operator had to ask explicitly ("discover endpoints")
  // before the LLM knew which queries existed — for AppSync-style APIs
  // that's a wasted round-trip and burned tokens.
  //
  // Fire-and-forget. Three failure modes that are NOT fatal:
  //   1. `introspection_disabled` — production-hardened APIs
  //      (Shopify Admin, some SaaS) refuse `__schema`. Logged at
  //      info, no audit row, no draft mutation. Operator can still
  //      hand-author queries; the LLM is told to ask for sample
  //      output instead via the skill content.
  //   2. `all_strategies_failed` — endpoint refused both
  //      introspection AND every fallback strategy (network, 4xx,
  //      etc.). Same soft-fail path — the connector itself probed
  //      green so it works, just without the schema corpus.
  //   3. Any other thrown error — logged warn, swallowed.
  // Skip auto-discovery on `oauth2` saves whose credential row hasn't
  // been written yet — the dance still has to run via
  // `authenticate_oauth`. Without this gate every oauth2 graphql save
  // fires unauth introspection, fails, and logs a noisy warn. The
  // post-`authenticate_oauth` path is responsible for kicking discovery
  // once the access token is bound.
  //
  // Also skipped when the caller opted out (`skipBackgroundDiscovery`) —
  // the green-probe auto-persist path does: the probe already proved the
  // endpoint live, the conversation continues immediately, and an
  // untracked background introspection there outlives the tool call (it
  // raced subsequent test/server fetches). Discovery still runs on
  // explicit saves and on demand via `discover_connector_endpoints`.
  const skipGraphqlDiscovery =
    p.skipBackgroundDiscovery === true ||
    (saved.auth_type === "oauth2" && credential_persisted !== true);
  if (saved.driver === "graphql" && saved.base_url && !skipGraphqlDiscovery) {
    void runDiscoveryCached(
      {
        db: ctx.db as Db,
        tenant_id: ctx.tenant_id,
        actor_id: ctx.actor_id,
      },
      {
        connector_id: saved.id,
        base_url: saved.base_url,
        // Thread the saved connector's environment so credential lookup
        // hits the right (tenant_id, connector_id, environment) row.
        // Without this every prod connector ran discovery against the
        // dev credential slot and silently warn-logged "discovery
        // failed" forever.
        environment: saved.environment,
      },
    )
      .then((out) => {
        // Surface per-strategy warnings into the audit trail so
        // operators see "openapi-direct 404, llms.txt empty,
        // graphql-introspect succeeded" without grepping logs.
        void recordConnectorDiscovered({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          executor: ctx.db,
          connector_id: saved.id,
          strategy: out.result.strategy,
          cache_key: out.cache_key,
          source: out.source,
          endpoint_count: out.result.endpoints.length,
          warnings: (out.result.warnings ?? []).map((w) => ({
            code: w.code,
            message: w.message,
          })),
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: unknown }).code)
            : null;
        // Differentiate the "schema is hidden by upstream" case from
        // an unexpected discovery breakage — operators reading the
        // log should see at a glance which one fired.
        const introspectionDisabled =
          code === "introspection_disabled" ||
          /introspection.*not allowed|introspection.*disabled/i.test(message);
        logger[introspectionDisabled ? "info" : "warn"]({
          module: "conversation_persistence",
          action: introspectionDisabled
            ? "post_save.graphql_introspection_disabled"
            : "post_save.graphql_discovery_failed",
          msg: introspectionDisabled
            ? "GraphQL connector saved without auto-discovery — upstream refuses introspection"
            : "auto-discovery after GraphQL connector save failed (non-fatal)",
          tenant_id: ctx.tenant_id,
          connector_id: saved.id,
          ...(code ? { code } : {}),
          error: message,
        });
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
      forced: true,
      cooldown_bypassed: cooldownBypassed,
    });
  }

  // Bound credentials = the connector_authenticated checkpoint flips
  // fresh atomically with the save. oauth2 connectors flip via
  // authenticate_oauth instead — no credential is bound at save time
  // for the authorization-code flow. Use the resolved `credential`
  // (which honours the draft-credential cache) rather than just
  // `p.credential`, so a cached credential collected via ask_user_form
  // earlier in the conversation also flips the gate.
  const credentialBound =
    connector.auth_type !== "none" && connector.auth_type !== "oauth2" && credential != null;
  let postSaveDraft = draft;
  if (credentialBound) {
    postSaveDraft = withConnectorAuthenticated(
      postSaveDraft,
      { ...connector, validation, saved_connector_id: saved.id },
      true,
      `Credential bound atomically with ${saved.slug} save.`,
      "save_connector_draft",
      "connector_saved",
    );
  }

  const nextDraft = withConnectorPersisted(
    postSaveDraft,
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
      saved_at: new Date(now()).toISOString(),
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
      ...connectorPersistEnvelopeFields({
        id: saved.id,
        slug: saved.slug,
        display_name: saved.display_name,
        environment: saved.environment,
        driver: saved.driver,
      }),
      ...(credential_persisted ? { credential_persisted: true } : {}),
      ...(analysis ? { document_analysis: analysis } : {}),
    },
  };
}
