import { eq } from "drizzle-orm";
import {
  recordConnectorCreated,
  recordConnectorDiscovered,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
} from "../../audit/recorders/index.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import { toPublicConnector } from "../../connectors/public-view.ts";
import {
  completeConnectorReauthorization,
  connectorSignsInInteractively,
  holdConnectorForSignIn,
} from "../../connectors/reauth.ts";
import { createConnector, getConnector, updateConnector } from "../../connectors/service.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import type { ConnectorView, UpdateConnectorInput } from "../../connectors/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { withTenantWork } from "../../execution/tenant-work.ts";
import { analyzeConversationAttachments } from "../../llm/flows/analyze-conversation-attachments.ts";
import { logger } from "../../logging/index.ts";
import { now } from "../../utils/clock.ts";
import {
  withConnectorAuthenticated,
  withConnectorPersisted,
  withConnectorValidation,
} from "../authoring-state/index.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
import {
  isStdioDraft,
  mcpConfigBlock,
  readLocalCommand,
  sameLocalCommand,
  withoutConfirmationFields,
} from "../local-command.ts";
import { auditActorFromToolContext, connectorActorFromToolContext } from "../tools/audit-actor.ts";
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

export function connectorFieldPatch(
  connector: ConnectorDraftDocument | null | undefined,
  existing: ConnectorView,
): UpdateConnectorInput {
  const patch: UpdateConnectorInput = {};
  if (!connector) return patch;
  const shown = toPublicConnector(existing);
  if (
    connector.base_url !== undefined &&
    connector.base_url !== (existing.base_url ?? undefined) &&
    connector.base_url !== (shown.base_url ?? undefined)
  ) {
    patch.base_url = connector.base_url;
  }
  if (
    connector.dsn !== undefined &&
    connector.dsn !== (existing.dsn ?? undefined) &&
    connector.dsn !== (shown.dsn ?? undefined)
  ) {
    patch.dsn = connector.dsn;
  }
  if (connector.name !== undefined && connector.name !== existing.display_name) {
    patch.name = connector.name;
  }
  if (connector.auth_type !== undefined && connector.auth_type !== existing.auth_type) {
    patch.auth_type = connector.auth_type;
  }
  const draftCommand = readLocalCommand(connector.config);
  const existingConfig = (existing.config ?? {}) as Record<string, unknown>;
  if (draftCommand && !sameLocalCommand(draftCommand, readLocalCommand(existingConfig))) {
    const draftMcp = mcpConfigBlock(connector.config) ?? {};
    patch.config = { ...existingConfig, mcp: withoutConfirmationFields(draftMcp) };
  }
  return patch;
}

const FORCE_SAVE_COOLDOWN_MS = 60_000;

export type AtomicCredentialInput =
  | { mode: "bearer"; token: string }
  | { mode: "signed_jwt"; private_key: string }
  | { mode: "basic"; username: string; password: string }
  | { mode: "header"; header_name: string; header_value: string }
  | { mode: "query"; param: string; value: string }
  | {
      mode: "cognito_user_password";
      username: string;
      password: string;
      aws_region?: string;
      client_id?: string;
      client_secret?: string;
      use_access_token?: boolean;
    }
  | {
      mode: "aws_sigv4";
      access_key_id: string;
      secret_access_key: string;
      session_token?: string;
    }
  | {
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
  forceSave?: boolean;
  forceSaveApproved?: boolean;
  reason?: string;
  emitAutoPersistAudit?: boolean;
  commitIntentKind?: string;
  skipBackgroundDiscovery?: boolean;
  localCommandConfirmation?: boolean;
}

export async function saveConnectorAtomic(p: SaveConnectorAtomicParams): Promise<ToolResult> {
  const { ctx } = p;
  const draft = ctx.getDraft();
  const connector = draft.connector;

  const existingSavedId = connector?.saved_connector_id ?? null;
  if (existingSavedId) {
    const existing = await getConnector(ctx.tenant_id, existingSavedId, ctx.db);
    if (existing) {
      const fieldPatch = connectorFieldPatch(connector, existing);
      const updatedFields = Object.keys(fieldPatch);
      const fieldsChanged = updatedFields.length > 0;
      if (fieldsChanged) {
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
        await updateConnector(
          ctx.tenant_id,
          existing.id,
          fieldPatch,
          connectorActorFromToolContext(ctx),
          ctx.db,
        );
      }

      let credential_persisted = false;
      if (p.credential) {
        await persistCredential({
          tenant_id: ctx.tenant_id,
          connector_id: existing.id,
          environment: p.environment,
          actor_id: ctx.actor_id,
          credential: p.credential,
          connectorConfig: (existing.config ?? {}) as Record<string, unknown>,
          driver: existing.driver,
          db: ctx.db as Db,
        });
        credential_persisted = true;
      }
      clearDraftCredential(ctx.conversation_id);
      if (credential_persisted) {
        const actor = connectorActorFromToolContext(ctx);
        await completeConnectorReauthorization(ctx.db as Db, {
          tenant_id: ctx.tenant_id,
          connector_id: existing.id,
          actor_id: ctx.actor_id,
          ...(actor?.kind === "unknown" ? { actor_type: "unknown" as const } : { actor }),
        });
      }
      if (p.emitAutoPersistAudit) {
        await recordConnectorUpdated({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          executor: ctx.db,
          connector_id: existing.id,
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
  const probeCheckpointFresh = missingFreshCheckpoints(draft, ["connector_probed"]).length === 0;
  const probeIsGreen = connector.latest_probe?.ok === true;
  const staleCheckpoints = probeCheckpointFresh && probeIsGreen ? [] : staleCheckpointsRaw;
  const authCanProbeBeforeSave =
    connector.auth_type !== "oauth2" &&
    connector.auth_type !== "oauth2_client" &&
    connector.auth_type !== "oauth2_private_key";
  const confirmsLocalCommand = p.localCommandConfirmation === true && isStdioDraft(connector);
  const requiresProbe =
    !confirmsLocalCommand &&
    authCanProbeBeforeSave &&
    (connector.driver === "http" ||
      connector.driver === "graphql" ||
      connector.driver === "postgres" ||
      connector.driver === "s3" ||
      connector.driver === "sftp" ||
      connector.driver === "mcp");
  const signsInLater = connectorSignsInInteractively(connector);
  const requiresCredential =
    connector.auth_type !== undefined &&
    connector.auth_type !== null &&
    connector.auth_type !== "none" &&
    !signsInLater;
  const blocking_reasons = [
    ...(draft.summary?.blocked_by ?? []).filter(
      (reason) =>
        reason === "inspect_connector_draft" ||
        reason === "validate_connector_draft" ||
        reason.startsWith("missing:"),
    ),
  ];
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

  let credential = p.credential;
  if ((requiresCredential || signsInLater) && !credential) {
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

  const probeFailed = requiresProbe && connector.latest_probe?.ok !== true;
  let cooldownBypassed = false;
  if (probeFailed && p.forceSave === true && connector.latest_probe) {
    const probedAtRaw = connector.latest_probe.probed_at;
    const probedAtMs = probedAtRaw ? Date.parse(probedAtRaw) : Number.NaN;
    const haveTimestamp = Number.isFinite(probedAtMs);
    const ageMs = haveTimestamp ? Math.max(0, now() - probedAtMs) : 0;
    const insideCooldown = haveTimestamp && ageMs < FORCE_SAVE_COOLDOWN_MS;
    if ((!haveTimestamp || insideCooldown) && p.forceSaveApproved === true) {
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
      actor: connectorActorFromToolContext(ctx),
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
      driver: saved.driver,
      db: ctx.db as Db,
    });
    credential_persisted = true;
  }
  clearDraftCredential(ctx.conversation_id);
  const sign_in = signsInLater ? await awaitInteractiveSignIn(ctx, saved) : null;

  if (p.emitAutoPersistAudit) {
    await recordConnectorCreated({
      tenant_id: ctx.tenant_id,
      ...auditActorFromToolContext(ctx),
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

  const skipGraphqlDiscovery =
    p.skipBackgroundDiscovery === true ||
    (saved.auth_type === "oauth2" && credential_persisted !== true);
  const discoveryBaseUrl = saved.base_url;
  if (saved.driver === "graphql" && discoveryBaseUrl && !skipGraphqlDiscovery) {
    const actor_type = ctx.principal?.kind ?? ctx.engineClient.context.actor_type;
    void withTenantWork(ctx.tenant_id, async () => {
      const out = await runDiscoveryCached(
        {
          db: ctx.db as Db,
          tenant_id: ctx.tenant_id,
          ...(actor_type ? { actor_type } : {}),
          actor_id: ctx.actor_id,
        },
        {
          connector_id: saved.id,
          base_url: discoveryBaseUrl,
          environment: saved.environment,
        },
      );
      await recordConnectorDiscovered({
        tenant_id: ctx.tenant_id,
        ...auditActorFromToolContext(ctx),
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
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : null;
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

  if (p.forceSave === true && requiresProbe && connector.latest_probe?.ok !== true) {
    await recordConnectorSavedOverride({
      tenant_id: ctx.tenant_id,
      ...auditActorFromToolContext(ctx),
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
      ...(sign_in ? { sign_in } : {}),
      ...(analysis ? { document_analysis: analysis } : {}),
    },
  };
}

async function awaitInteractiveSignIn(
  ctx: ToolContext,
  saved: ConnectorView,
): Promise<{ state: "needs_sign_in"; start: string | null; next_best_actions: string[] }> {
  const { state, start } = await holdConnectorForSignIn(ctx.db, saved);
  logger.info({
    module: "conversation_persistence",
    action: "save_connector.sign_in_pending",
    msg: "connector saved before its interactive sign-in; it waits for the OAuth sign-in",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    connector_id: saved.id,
    sign_in_state: state,
  });
  return { state, start, next_best_actions: ["request_connector_reauth"] };
}
