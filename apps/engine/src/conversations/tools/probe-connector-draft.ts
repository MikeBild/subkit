import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { classifyHttpSideEffect } from "@shared/index.ts";
import { UNDESCRIBED_METADATA } from "../../api/catalog-metadata.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { probeGraphQLConnector } from "../../connectors/drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import { type McpProbeManifest, probeMcpConnector } from "../../connectors/drivers/mcp.ts";
import { probePgConnector } from "../../connectors/drivers/postgres.ts";
import { probeS3Connector } from "../../connectors/drivers/s3.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import { logger } from "../../logging/logger.ts";
import { withConnectorProbe, withConnectorValidation } from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
import { proposeConnectorCapabilityCandidate } from "../persistence/connector-skill-candidate.ts";
import { credentialModeMatchesAuthType } from "../persistence/credential-form-contract.ts";
import {
  clearDraftCredential,
  getDraftCredential,
  mintM2mDraftCredential,
  toDecryptedCredential,
  toDecryptedCredentialAsync,
} from "../persistence/draft-credential-cache.ts";
import type { AtomicCredentialInput } from "../persistence/save-connector.ts";
import { saveConnectorAtomic } from "../persistence/save-connector.ts";
import type { ConnectorDraftProbeSummary } from "../types.ts";
import { auditActorFromToolContext } from "./audit-actor.ts";
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { resolveDraftProbeSecrets } from "./probe-draft-secrets.ts";
import { pickProbeRecoveryActions as pickFromShared, probeStatusHint } from "./probe-recovery.ts";
import { truncateForLlm } from "./truncate.ts";

const inputSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    path: z.string().min(1).default("/"),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    timeout_ms: z.number().int().min(100).max(60_000).default(15_000),
  })
  .openapi("ProbeConnectorDraftToolInput");

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}

export function computeProbeFingerprint(
  draftView: {
    driver: string;
    base_url: string | null;
    dsn: string | null;
    auth_type: string;
    environment: string;
    config: Record<string, unknown>;
  },
  args: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean> | undefined;
    body?: unknown;
    headers?: Record<string, string> | undefined;
  },
  credential: AtomicCredentialInput | null,
): string {
  const credentialSha256 = createHash("sha256")
    .update(stableStringify(credential ?? null))
    .digest("hex");
  const effectiveProbe =
    draftView.driver === "http"
      ? {
          method: args.method,
          path: args.path,
          query: args.query ?? null,
          body: args.body ?? null,
          headers: args.headers ?? null,
        }
      : null;
  return createHash("sha256")
    .update(
      stableStringify({
        driver: draftView.driver,
        base_url: draftView.base_url,
        dsn: draftView.dsn,
        auth_type: draftView.auth_type,
        environment: draftView.environment,
        config: draftView.config,
        probe: effectiveProbe,
        credential_sha256: credentialSha256,
      }),
    )
    .digest("hex");
}

function isTransientProbeFailure(probe: ConnectorDraftProbeSummary): boolean {
  if (probe.failure_code === "probe_timeout") return true;
  const status = probe.status_code;
  return typeof status === "number" && (status === 429 || status >= 500);
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  if (error instanceof Error) {
    return /timed? out|timeout|aborted/i.test(error.message);
  }
  return /timed? out|timeout|aborted/i.test(String(error));
}

export const probeConnectorDraftTool: ConversationTool = {
  name: "probe_connector_draft",
  description:
    "Probe the current connector draft before saving it. MCP drafts perform a throwaway initialize + tools/list handshake; no draft secret is persisted before success.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "connector",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const connector = currentDraft.connector;
    const resolvedTemplates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const validation = validateConnectorDraft(
      connector ?? null,
      resolvedTemplates.map((entry) => entry.template),
    );
    if (!connector) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "connector_missing",
          message: "start a connector draft before probing it",
          recommended_mode: "connector",
        }),
      };
    }
    if (!validation.ok) {
      const nextDraft = withConnectorValidation(
        currentDraft,
        { ...connector, validation },
        false,
        "Connector draft is incomplete and cannot be probed yet.",
        "connector_probe_blocked",
      );
      await ctx.setDraft(nextDraft);
      return {
        ok: false,
        data: buildGateError(nextDraft, {
          error_code: "validation_failed",
          message: "connector draft is incomplete",
          stale_checkpoints: ["connector_validated"],
          recommended_mode: "connector",
          extra: {
            validation,
          },
        }),
      };
    }
    const effectiveDriver = connector.driver ?? "http";
    if (effectiveDriver === "http" && classifyHttpSideEffect({ method: args.method }) !== "read") {
      const summary =
        "Write probe held. Validate with a read-only development probe, save the connector, then review the exact write with call_connector.";
      const latest_probe = {
        ok: false,
        method: args.method,
        path: args.path,
        environment: args.environment ?? connector.environment ?? "dev",
        duration_ms: 0,
        summary,
        failure_code: "draft_write_held",
        probed_at: new Date().toISOString(),
      };
      const nextDraft = withConnectorProbe(
        currentDraft,
        { ...connector, validation, latest_probe },
        false,
        summary,
        "connector_probe_blocked",
      );
      await ctx.setDraft(nextDraft);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: "denied",
          reason: "draft_write_held",
          metadata: {
            request_source: "chat",
            driver: effectiveDriver,
            environment: latest_probe.environment,
            draft_only: true,
            held: true,
          },
        },
        ctx.db,
      );
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          held: true,
          error_code: "draft_write_held",
          latest_probe,
          recommended_next: ["probe_connector_draft", "save_connector_draft", "call_connector"],
        }),
      };
    }
    const secrets = await resolveDraftProbeSecrets(ctx.tenant_id, connector, ctx.db);
    if (!secrets.ok) return { ok: false, data: buildGateError(currentDraft, secrets.refusal) };
    const draftView = {
      id: connector.saved_connector_id ?? `draft-${ctx.conversation_id}`,
      tenant_id: ctx.tenant_id,
      slug: connector.slug ?? "draft-connector",
      display_name: connector.name ?? "Draft connector",
      ...UNDESCRIBED_METADATA,
      driver: effectiveDriver,
      environment: args.environment ?? connector.environment ?? "dev",
      auth_type: connector.auth_type ?? "none",
      base_url: secrets.base_url,
      dsn: secrets.dsn,
      config: secrets.config,
      operator_quirks: {},
      template_slug: connector.template_slug ?? null,
      template_name: connector.template_name ?? null,
      template_source: connector.template_source ?? null,
      template_version: null,
      template_snapshot: null,
      self_description: {},
      created_at: new Date(),
      updated_at: new Date(),
      enabled: true,
      last_error: null,
      circuit_state: "closed" as const,
      circuit_opened_at: null,
      circuit_failure_count: 0,
      circuit_threshold: 5,
      circuit_reset_ms: 300000,
      needs_reauth: false,
      auth_failed_at: null,
      auth_failed_reason: null,
      health_state: "ok",
      health_reason: null,
      health_error_code: null,
      sunset_at: null,
      successor_uri: null,
    };

    if (connector.driver === "postgres" || connector.driver === "s3") {
      const started = Date.now();
      const res =
        connector.driver === "postgres"
          ? await probePgConnector(draftView, ctx.db)
          : await probeS3Connector({ db: ctx.db, tenant_id: ctx.tenant_id, connector: draftView });
      const duration_ms = Date.now() - started;
      const latest_probe = {
        ok: res.ok,
        method: connector.driver === "postgres" ? "SELECT 1" : "HEAD /",
        path: "(driver handshake)",
        environment: draftView.environment,
        ...(typeof (res as { status?: number }).status === "number"
          ? { status_code: (res as { status?: number }).status as number }
          : {}),
        duration_ms,
        summary: res.ok
          ? `${connector.driver} probe succeeded in ${duration_ms}ms.`
          : `${connector.driver} probe failed: ${res.detail ?? "unknown error"}`,
        ...(res.ok
          ? {}
          : {
              failure_code: "probe_failed",
              fingerprint: computeProbeFingerprint(
                draftView,
                args,
                getDraftCredential(ctx.conversation_id),
              ),
            }),
        probed_at: new Date().toISOString(),
      };
      const nextDraft = withConnectorProbe(
        currentDraft,
        { ...connector, validation, latest_probe },
        res.ok,
        latest_probe.summary,
        res.ok ? "connector_probed" : "connector_probe_failed",
      );
      await ctx.setDraft(nextDraft);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: res.ok ? "success" : "error",
          metadata: {
            connector_name: connector.name ?? null,
            connector_slug: connector.slug ?? null,
            environment: draftView.environment,
            driver: connector.driver,
            duration_ms,
            draft_only: true,
          },
        },
        ctx.db,
      );
      return {
        ok: res.ok,
        data: buildLifecyclePayload(nextDraft, {
          connector: {
            ...toCreateConnectorInput(connector),
            environment: draftView.environment,
          },
          latest_probe,
          detail: res.detail ?? null,
        }),
      };
    }

    const buildProbeGateEnvelope = async (params: {
      failure_code:
        | "credential_required"
        | "authenticate_oauth_required"
        | "credential_mode_mismatch"
        | "token_exchange_failed";
      summary: string;
      error_message: string;
      recommended_next: string[];
    }): Promise<ToolResult> => {
      const nextDraft = withConnectorProbe(
        currentDraft,
        {
          ...connector,
          validation,
          latest_probe: {
            ok: false,
            method: args.method,
            path: args.path,
            environment: draftView.environment,
            duration_ms: 0,
            summary: params.summary,
            failure_code: params.failure_code,
            probed_at: new Date().toISOString(),
          },
        },
        false,
        `${params.failure_code}: ${params.error_message}`,
        "connector_probe_failed",
      );
      await ctx.setDraft(nextDraft);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: "error",
          metadata: {
            connector_name: connector.name ?? null,
            connector_slug: connector.slug ?? null,
            environment: draftView.environment,
            driver: connector.driver,
            duration_ms: 0,
            draft_only: true,
            failure_code: params.failure_code,
          },
        },
        ctx.db,
      );
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          error_code: params.failure_code,
          error: params.error_message,
          latest_probe: nextDraft.connector?.latest_probe ?? null,
          recommended_next: params.recommended_next,
        }),
      };
    };

    const draftCredential =
      draftView.auth_type !== "none" ? getDraftCredential(ctx.conversation_id) : null;
    if (draftView.auth_type !== "none" && !draftCredential && !connector.saved_connector_id) {
      return buildProbeGateEnvelope({
        failure_code: "credential_required",
        summary:
          "Probe blocked: no credential collected yet for this draft. Run ask_user_form(type: password, sensitive: true) to collect the secret, then re-probe.",
        error_message:
          "Cannot probe an auth-required draft without a credential. Collect it via ask_user_form(type: password, sensitive: true) — the harness caches the secret in memory and the next probe will use it.",
        recommended_next: ["ask_user_form"],
      });
    }

    if (
      draftCredential &&
      !credentialModeMatchesAuthType(draftCredential.mode, draftView.auth_type)
    ) {
      clearDraftCredential(ctx.conversation_id);
      return buildProbeGateEnvelope({
        failure_code: "credential_mode_mismatch",
        summary: `Probe blocked: cached credential mode "${draftCredential.mode}" does not match the draft's auth_type "${draftView.auth_type}". The stale credential was cleared.`,
        error_message: `The cached draft credential (mode: ${draftCredential.mode}) was collected for a different auth shape than the draft now declares (auth_type: ${draftView.auth_type}). The stale credential has been cleared — re-collect a matching credential via ask_user_form(type: password, sensitive: true), then re-probe.`,
        recommended_next: ["ask_user_form"],
      });
    }

    const draftCfg = (draftView.config ?? {}) as {
      aws_region?: unknown;
      oauth?: Record<string, unknown>;
    };
    const oauthCfg = (draftCfg.oauth ?? {}) as Record<string, unknown>;
    const oauthGrantType = typeof oauthCfg.grant_type === "string" ? oauthCfg.grant_type : null;

    if (draftCredential?.mode === "oauth2" && oauthGrantType !== "client_credentials_json") {
      return buildProbeGateEnvelope({
        failure_code: "authenticate_oauth_required",
        summary:
          "Probe blocked: this OAuth2 draft uses a browser-based grant and has no access token yet. Save the draft, then run authenticate_oauth and complete the browser exchange before probing. (Machine-to-machine grants like client_credentials_json probe directly — no browser needed.)",
        error_message:
          "Cannot probe a browser-grant OAuth2 draft before authenticate_oauth completes. Save the draft, run authenticate_oauth, finish the browser exchange, then probe.",
        recommended_next: ["save_connector_draft", "authenticate_oauth"],
      });
    }

    const region =
      (typeof draftCfg.aws_region === "string" && draftCfg.aws_region) ||
      (typeof oauthCfg.aws_region === "string" && oauthCfg.aws_region) ||
      null;
    const clientId = typeof oauthCfg.client_id === "string" ? oauthCfg.client_id : null;
    let credentialOverride: DecryptedCredential | null = null;
    if (draftCredential?.mode === "oauth2") {
      try {
        credentialOverride = await mintM2mDraftCredential(draftCredential, oauthCfg, {
          tenant_id: ctx.tenant_id,
          exec: ctx.db,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const endpoint =
          draftCredential.token_endpoint ??
          (typeof oauthCfg.token_endpoint === "string" ? oauthCfg.token_endpoint : "(unset)");
        return buildProbeGateEnvelope({
          failure_code: "token_exchange_failed",
          summary: `Token exchange against ${endpoint} failed: ${msg}`,
          error_message: `client_credentials_json token exchange against ${endpoint} failed: ${msg}. Verify the client_id/client_secret pair (re-collect via ask_user_form) and the token endpoint, then re-probe.`,
          recommended_next: ["ask_user_form", "update_connector_draft"],
        });
      }
    } else {
      try {
        credentialOverride = draftCredential
          ? draftCredential.mode === "cognito_user_password"
            ? await toDecryptedCredentialAsync(
                draftCredential,
                {
                  aws_region: region,
                  client_id: clientId,
                },
                { tenant_id: ctx.tenant_id, exec: ctx.db },
              )
            : toDecryptedCredential(draftCredential)
          : null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return buildProbeGateEnvelope({
          failure_code: "credential_required",
          summary: msg,
          error_message: msg,
          recommended_next: ["update_connector_draft"],
        });
      }
    }

    const probeFingerprint = computeProbeFingerprint(draftView, args, draftCredential);
    const lastProbe = connector.latest_probe ?? null;
    if (
      lastProbe &&
      lastProbe.ok === false &&
      lastProbe.fingerprint === probeFingerprint &&
      !isTransientProbeFailure(lastProbe)
    ) {
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: "denied",
          metadata: {
            connector_name: connector.name ?? null,
            connector_slug: connector.slug ?? null,
            environment: draftView.environment,
            driver: connector.driver,
            duration_ms: 0,
            draft_only: true,
            failure_code: "probe_unchanged",
          },
        },
        ctx.db,
      );
      return {
        ok: false,
        data: buildLifecyclePayload(currentDraft, {
          error_code: "probe_unchanged",
          error:
            "This exact probe already failed and nothing has changed since — the draft (driver, base_url, auth_type, config), the cached credential, and the probe arguments are identical to the last failed attempt. Do NOT re-probe. Read latest_probe.response_preview and response_headers for the upstream's own diagnosis, verify the endpoint via fetch_connector_docs / search_docs, or change the base_url / credential before probing again.",
          latest_probe: lastProbe,
          recommended_next: ["fetch_connector_docs", "search_docs", "update_connector_draft"],
        }),
      };
    }

    const finishWithGreenProbeAutoPersist = async (
      latest_probe: Record<string, unknown>,
      probe_duration_ms: number,
      probe_status_code?: number,
      mcp_manifest?: McpProbeManifest,
    ): Promise<ToolResult> => {
      const connectorLabel = connector.name ?? connector.slug ?? "this connector";
      const saveResult = await saveConnectorAtomic({
        ctx,
        environment: draftView.environment,
        reason: "auto_persist_on_green_probe",
        emitAutoPersistAudit: true,
        commitIntentKind: "save_connector",
        skipBackgroundDiscovery: true,
      });
      if (!saveResult.ok) {
        logger.warn({
          module: "conversation_tool",
          action: "probe_connector_draft.auto_save_failed",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          error_code: (saveResult.data as { error_code?: unknown } | undefined)?.error_code ?? null,
        });
        return saveResult;
      }
      const saved =
        typeof saveResult.data === "object" && saveResult.data !== null
          ? (saveResult.data as Record<string, unknown>)
          : {};
      const savedConnector =
        saved.connector && typeof saved.connector === "object"
          ? (saved.connector as Record<string, unknown>)
          : null;
      logger.info({
        module: "conversation_tool",
        action: "probe_connector_draft.auto_saved",
        msg: "green probe auto-persisted connector inline",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: typeof savedConnector?.id === "string" ? savedConnector.id : null,
        connector_slug: typeof savedConnector?.slug === "string" ? savedConnector.slug : null,
        driver: effectiveDriver,
        environment: draftView.environment,
        probe_duration_ms,
        ...(probe_status_code !== undefined ? { probe_status_code } : {}),
      });
      const skillCandidateNotice =
        mcp_manifest && typeof savedConnector?.id === "string"
          ? await proposeConnectorCapabilityCandidate({
              db: ctx.db,
              tenant_id: ctx.tenant_id,
              conversation_id: ctx.conversation_id,
              connector_id: savedConnector.id,
              purpose: connector.description ?? null,
              manifest: mcp_manifest,
            })
          : null;
      return {
        ok: true,
        data: {
          ...saved,
          ...(skillCandidateNotice ? { skill_candidate: skillCandidateNotice } : {}),
          auto_saved: true,
          auto_save_reason: "auto_persist_on_green_probe",
          latest_probe,
          next_best_actions: ["author_workflow", "list_workflows"],
          next_prompt: `${connectorLabel} saved. What workflow should it power?`,
        },
      };
    };

    if (connector.driver === "mcp") {
      const started = Date.now();
      const res = await probeMcpConnector({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector: draftView,
        credential_override: credentialOverride,
        requestSource: "mcp",
      });
      const duration_ms = Date.now() - started;
      const latest_probe = {
        ok: res.ok,
        method: "MCP initialize + tools/list",
        path: "(protocol handshake)",
        environment: draftView.environment,
        duration_ms,
        summary: res.ok
          ? `MCP handshake probe succeeded in ${duration_ms}ms: ${res.detail ?? "manifest received"}.`
          : `MCP handshake probe failed: ${res.detail ?? "unknown error"}`,
        ...(res.ok
          ? {}
          : {
              failure_code: res.error_code ?? "probe_failed",
              fingerprint: probeFingerprint,
            }),
        probed_at: new Date().toISOString(),
      };
      const nextDraft = withConnectorProbe(
        currentDraft,
        { ...connector, validation, latest_probe },
        res.ok,
        latest_probe.summary,
        res.ok ? "connector_probed" : "connector_probe_failed",
      );
      await ctx.setDraft(nextDraft);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: res.ok ? "success" : "error",
          metadata: {
            connector_name: connector.name ?? null,
            connector_slug: connector.slug ?? null,
            environment: draftView.environment,
            driver: "mcp",
            duration_ms,
            draft_only: true,
          },
        },
        ctx.db,
      );
      if (!res.ok) {
        return {
          ok: false,
          data: buildLifecyclePayload(nextDraft, {
            connector: {
              ...toCreateConnectorInput(connector),
              environment: draftView.environment,
            },
            latest_probe,
            detail: res.detail ?? null,
            next_best_actions: ["inspect_connector_draft", "update_connector_draft"],
          }),
        };
      }
      return finishWithGreenProbeAutoPersist(latest_probe, duration_ms, undefined, res.manifest);
    }

    if (connector.driver === "graphql") {
      const started = Date.now();
      const res = await probeGraphQLConnector({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector: draftView,
        ...(credentialOverride ? { credential_override: credentialOverride } : {}),
      });
      const duration_ms = Date.now() - started;
      const latest_probe = {
        ok: res.ok,
        method: "POST",
        path: "(introspection)",
        environment: draftView.environment,
        ...(typeof res.status === "number" ? { status_code: res.status } : {}),
        duration_ms,
        summary: res.ok
          ? `GraphQL introspection probe succeeded in ${duration_ms}ms.`
          : `GraphQL probe failed: ${res.detail ?? `HTTP ${res.status ?? 0}`}.${probeStatusHint(res.status ?? 0)}`,
        ...(res.ok
          ? {}
          : {
              failure_code: "probe_failed",
              fingerprint: probeFingerprint,
              ...(res.body_snippet !== undefined ? { response_preview: res.body_snippet } : {}),
              ...(res.response_headers !== undefined
                ? { response_headers: res.response_headers }
                : {}),
            }),
        probed_at: new Date().toISOString(),
      };
      const nextDraft = withConnectorProbe(
        currentDraft,
        { ...connector, validation, latest_probe },
        res.ok,
        latest_probe.summary,
        res.ok ? "connector_probed" : "connector_probe_failed",
      );
      await ctx.setDraft(nextDraft);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          result: res.ok ? "success" : "error",
          metadata: {
            connector_name: connector.name ?? null,
            connector_slug: connector.slug ?? null,
            environment: draftView.environment,
            driver: "graphql",
            duration_ms,
            draft_only: true,
          },
        },
        ctx.db,
      );
      if (!res.ok) {
        return {
          ok: false,
          data: buildLifecyclePayload(nextDraft, {
            connector: {
              ...toCreateConnectorInput(connector),
              environment: draftView.environment,
            },
            latest_probe,
            detail: res.detail ?? null,
            next_best_actions: pickProbeRecoveryActions({
              status: res.status ?? null,
              failure_code: "probe_failed",
            }),
          }),
        };
      }
      return finishWithGreenProbeAutoPersist(latest_probe, duration_ms, res.status ?? 200);
    }

    const started = Date.now();
    let status = 0;
    let responseBody: unknown = null;
    let errorDetail: string | null = null;
    let requestUrl = "";

    try {
      const execution = await executeConnectorHttpRequest({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        connector: draftView,
        method: args.method,
        path_or_url: args.path,
        ...(args.headers ? { headers: args.headers } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        timeout_ms: args.timeout_ms,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        ...(credentialOverride ? { credential_override: credentialOverride } : {}),
      });
      requestUrl = execution.url;
      status = execution.status;
      responseBody = execution.body;
    } catch (error) {
      errorDetail = error instanceof Error ? error.message : String(error);
    }

    const duration_ms = Date.now() - started;
    const truncated = truncateForLlm(responseBody);
    const probed_at = new Date().toISOString();
    const latest_probe = errorDetail
      ? {
          ok: false,
          method: args.method,
          path: args.path,
          environment: draftView.environment,
          duration_ms,
          summary: isTimeoutError(errorDetail)
            ? `Probe timed out after ${args.timeout_ms}ms.`
            : `Probe failed: ${errorDetail}`,
          failure_code: isTimeoutError(errorDetail) ? "probe_timeout" : "probe_failed",
          fingerprint: probeFingerprint,
          probed_at,
        }
      : {
          ok: status >= 200 && status < 400,
          method: args.method,
          path: args.path,
          environment: draftView.environment,
          status_code: status,
          duration_ms,
          summary:
            status >= 200 && status < 400
              ? `Probe succeeded with HTTP ${status}.`
              : `Probe reached the system but returned HTTP ${status}.${probeStatusHint(status)}`,
          response_preview: truncated.data,
          ...(status >= 200 && status < 400 ? {} : { fingerprint: probeFingerprint }),
          probed_at,
        };
    const nextDraft = withConnectorProbe(
      currentDraft,
      { ...connector, validation, latest_probe },
      latest_probe.ok,
      latest_probe.summary,
      errorDetail ? "connector_probe_failed" : "connector_probed",
    );
    await ctx.setDraft(nextDraft);
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        ...auditActorFromToolContext(ctx),
        action: AuditAction.CONVERSATION_PROBE_CONNECTOR,
        resource_type: "conversation",
        resource_id: ctx.conversation_id,
        result: errorDetail ? "error" : "success",
        metadata: {
          connector_name: connector.name ?? null,
          connector_slug: connector.slug ?? null,
          environment: draftView.environment,
          method: args.method,
          path: args.path,
          url_host: requestUrl ? new URL(requestUrl).host : null,
          status_code: status,
          duration_ms,
          draft_only: true,
        },
      },
      ctx.db,
    );
    if (errorDetail) {
      const nextBestActions = pickProbeRecoveryActions(latest_probe);
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          error: errorDetail,
          error_code: latest_probe.failure_code ?? "probe_failed",
          latest_probe,
          next_best_actions: nextBestActions,
        }),
      };
    }
    return finishWithGreenProbeAutoPersist(latest_probe, duration_ms, status);
  },
};

export const pickProbeRecoveryActions = pickFromShared;
