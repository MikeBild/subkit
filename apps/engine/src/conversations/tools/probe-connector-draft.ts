import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { probeGraphQLConnector } from "../../connectors/drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import { probePgConnector } from "../../connectors/drivers/postgres.ts";
import { probeS3Connector } from "../../connectors/drivers/s3.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import { logger } from "../../logging/logger.ts";
import { withConnectorProbe, withConnectorValidation } from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
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
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
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

/** Deterministic JSON encoding (sorted object keys) so the fingerprint
 *  is stable across turns regardless of property insertion order. */
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

/**
 * Identity of a probe attempt: everything that could change its outcome
 * — the draft's connection shape, the probe arguments, and the cached
 * credential (as a sha256, NEVER the raw secret). Two probes with the
 * same fingerprint are guaranteed to hit the same endpoint the same way
 * with the same auth material, so re-running one that just failed
 * non-transiently is pure turn burn (session 97679846 re-probed an
 * unchanged Jira GraphQL draft 3× into the same 403).
 */
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
  // Fingerprint the EFFECTIVE probe request, not the raw model args:
  // only the http driver shapes its probe from args — graphql always
  // fires the fixed `{ __typename }` introspection and postgres/s3
  // probe the connection itself. Hashing raw args there lets per-turn
  // arg jitter (path "/" vs omitted, ad-hoc headers) defeat the
  // re-probe guard with an identical request on the wire.
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

/** A failed probe whose outcome could legitimately change on an
 *  identical retry: rate limiting (429), upstream errors (5xx), or a
 *  timeout. The `probe_unchanged` guard skips these. */
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
    "Probe the current connector draft before saving it. Use this as the normal verification step for HTTP and GraphQL connectors.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const connector = currentDraft.connector;
    const validation = validateConnectorDraft(connector ?? null);
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
    // Once the draft is bound to a saved connector, probe under that
    // connector's real id so the drivers resolve its credential from the
    // encrypted vault. A fresh (unsaved) draft keeps the synthetic id —
    // it has no `connector_credentials` row, so it relies on the
    // in-memory draft credential instead.
    const draftView = {
      id: connector.saved_connector_id ?? `draft-${ctx.conversation_id}`,
      tenant_id: ctx.tenant_id,
      slug: connector.slug ?? "draft-connector",
      display_name: connector.name ?? "Draft connector",
      driver: effectiveDriver,
      environment: args.environment ?? connector.environment ?? "dev",
      auth_type: connector.auth_type ?? "none",
      base_url: connector.base_url ?? null,
      dsn: connector.dsn ?? null,
      config: connector.config ?? {},
      operator_quirks: {},
      template_slug: connector.template_slug ?? null,
      template_name: connector.template_name ?? null,
      template_source: connector.template_source ?? null,
      template_version: null,
      template_snapshot: null,
      created_at: new Date(),
      updated_at: new Date(),
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

    // Non-HTTP drivers run their dedicated read-only probe (connect +
    // shape check). HTTP continues below — it needs the full plan
    // builder so users can probe arbitrary endpoints, not just the
    // driver's canned handshake.
    if (connector.driver === "postgres" || connector.driver === "s3") {
      const started = Date.now();
      const res =
        connector.driver === "postgres"
          ? await probePgConnector(draftView)
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
          actor_type: ctx.actor_id ? "user" : "system",
          actor_id: ctx.actor_id,
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

    // Single helper for the gate-denial envelopes below. Builds the
    // failing probe payload, persists it to the draft snapshot, and
    // emits a `CONVERSATION_PROBE_CONNECTOR` audit row with
    // result:"error" so operators can see the denial in the audit
    // stream alongside successful probes.
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
          actor_type: ctx.actor_id ? "user" : "system",
          actor_id: ctx.actor_id,
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

    // Auth-required drafts need a credential before the probe can be
    // meaningful. We read it from the in-memory draft cache populated
    // when the user filled the `ask_user_form`. Without it, the request
    // goes out unauthenticated and the symptom (HTTP 401 / "Last used:
    // Never" on the upstream) is indistinguishable from a real auth
    // failure.
    //
    // EXCEPTION: once the draft is bound to a saved connector, its
    // credential already lives in the encrypted vault. A save clears the
    // in-memory draft credential, so re-probing a saved connector finds
    // no draft credential — but it must NOT re-demand one. We probe
    // under the saved connector's id (set on `draftView` above) and let
    // the driver resolve the stored credential.
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

    // Cache consistency: a cached credential collected for a
    // DIFFERENT auth shape must never drive a probe. Pre-fix a bearer
    // token cached before an auth_type switch to basic survived in the
    // cache and the probe went out with `Authorization: Bearer …`
    // against a basic-auth endpoint — a 401 indistinguishable from a
    // wrong secret. Clear the stale entry and demand re-collection.
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

    // Read the draft's oauth config once — the machine-to-machine grant
    // check below and the cognito region/client_id resolution both need
    // it. `aws_region` is accepted on either `config.aws_region` (the
    // canonical slot the template seeds) OR `config.oauth.aws_region`
    // (the LLM occasionally nests it there). Same for `client_id`.
    const draftCfg = (draftView.config ?? {}) as {
      aws_region?: unknown;
      oauth?: Record<string, unknown>;
    };
    const oauthCfg = (draftCfg.oauth ?? {}) as Record<string, unknown>;
    const oauthGrantType = typeof oauthCfg.grant_type === "string" ? oauthCfg.grant_type : null;

    // OAuth2 seed credentials: BROWSER-based grants cannot drive a
    // probe — the access token is minted later by authenticate_oauth +
    // the OAuth callback. Machine-to-machine grants
    // (client_credentials_json) are different: the engine mints the
    // bearer inline from the cached client_id/client_secret (the
    // cognito_user_password branch below is the precedent), so the
    // probe verifies the credentials immediately — no save, no browser.
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

    // Resolve the in-memory credential override for the probe. For
    // `cognito_user_password` the cached credential is the raw username +
    // password; the async helper mints an IdToken via Cognito InitiateAuth.
    // Other modes round-trip through the sync converter.
    //
    // `aws_region` is accepted on either `config.aws_region` (the canonical
    // slot the template seeds) OR `config.oauth.aws_region` (the LLM
    // occasionally nests it there). Both are valid. Same for `client_id`.
    //
    // Wrap in its own try/catch so a missing region/client_id on a Cognito
    // draft returns a structured `credential_required` envelope rather than
    // crashing the HTTP path's try/catch and losing the typed error message.
    const region =
      (typeof draftCfg.aws_region === "string" && draftCfg.aws_region) ||
      (typeof oauthCfg.aws_region === "string" && oauthCfg.aws_region) ||
      null;
    const clientId = typeof oauthCfg.client_id === "string" ? oauthCfg.client_id : null;
    let credentialOverride: DecryptedCredential | null = null;
    if (draftCredential?.mode === "oauth2") {
      // Reachable only for client_credentials_json (the browser-grant
      // gate above returned for everything else): mint the bearer
      // inline so the probe carries real auth. A failed exchange is a
      // REAL probe verdict — the credentials are wrong or the token
      // endpoint is unreachable — so surface it as such instead of a
      // generic credential prompt.
      try {
        credentialOverride = await mintM2mDraftCredential(draftCredential, oauthCfg);
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
            ? await toDecryptedCredentialAsync(draftCredential, {
                aws_region: region,
                client_id: clientId,
              })
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

    // Re-probe guard: an identical probe of an unchanged draft +
    // credential cannot succeed where the last one failed — unless the
    // failure was transient (429 / 5xx / timeout). Session 97679846
    // re-probed an unchanged Jira GraphQL draft 3× into the same 403.
    // Refuse WITHOUT firing the network call, return the cached failed
    // probe, and audit the denial so the loop is visible to operators.
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
          actor_type: ctx.actor_id ? "user" : "system",
          actor_id: ctx.actor_id,
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

    // Local helper: after a green probe, auto-persist the connector + credential
    // atomically and return the enriched success envelope. Called from both the
    // graphql branch (on ok: true) and the HTTP path's probe-success tail.
    const finishWithGreenProbeAutoPersist = async (
      latest_probe: Record<string, unknown>,
      probe_duration_ms: number,
      probe_status_code: number,
    ): Promise<ToolResult> => {
      const connectorLabel = connector.name ?? connector.slug ?? "this connector";
      const saveResult = await saveConnectorAtomic({
        ctx,
        environment: draftView.environment,
        reason: "auto_persist_on_green_probe",
        emitAutoPersistAudit: true,
        commitIntentKind: "save_connector",
        // The probe just proved the endpoint live; a fire-and-forget
        // introspection here would outlive this tool call. Discovery
        // remains available via discover_connector_endpoints.
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
        probe_status_code,
      });
      return {
        ok: true,
        data: {
          ...saved,
          auto_saved: true,
          auto_save_reason: "auto_persist_on_green_probe",
          latest_probe,
          next_best_actions: ["start_workflow_from_goal", "list_workflows"],
          next_prompt: `${connectorLabel} saved. What workflow should it power?`,
        },
      };
    };

    // GraphQL connectors ALWAYS use the introspection probe, regardless of
    // the `path` arg. A graphql-driver connector must never fall through to
    // the raw-HTTP path which sends an empty POST body — that returns a 400
    // from every real GraphQL endpoint.
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
        // On failure carry the upstream's own words — scrubbed body
        // snippet + allowlisted diagnostic headers from the driver — so
        // the LLM/operator can read the real cause instead of "HTTP 403".
        ...(res.ok
          ? {}
          : {
              failure_code: "probe_failed",
              // Identity of this failed attempt — the re-probe guard
              // refuses an identical retry until something changes.
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
          actor_type: ctx.actor_id ? "user" : "system",
          actor_id: ctx.actor_id,
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
        // Same structured recovery hint as the HTTP path. Pass the
        // ProbeFailureSignal shape explicitly — the GraphQL latest_probe
        // stores the status under `status_code`, so passing it verbatim
        // would classify every failure as the catch-all bucket.
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
          // Only failed probes carry a fingerprint — the re-probe
          // guard keys on it; green probes auto-persist and move on.
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
        actor_type: ctx.actor_id ? "user" : "system",
        actor_id: ctx.actor_id,
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
      // Probe failure with structured next-best-actions so the LLM
      // doesn't have to guess the recovery move. Pre-fix a 404 left
      // the LLM to manually decide whether to call search_docs,
      // discover_connector_endpoints, or update the path — the
      // session ebd66982 trace showed the LLM pivoting to "let me
      // check the DigitalOcean API documentation" without prompting,
      // costing extra turns. The hint maps the HTTP status to the
      // most likely fix.
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
    // Probe-success envelope. A green probe is consent to persist —
    // the credentials work, the draft is validated, there is no
    // ambiguity left for the operator to resolve. Delegate to the
    // shared helper which calls saveConnectorAtomic inline, logs, and
    // builds the enriched envelope.
    return finishWithGreenProbeAutoPersist(latest_probe, duration_ms, status);
  },
};

/**
 * Backwards-compatible re-export. The mapping itself lives in
 * `./probe-recovery.ts` so probe_connector / dry_run_step share the
 * same surface. Kept here for the existing test that imports from
 * this file.
 *
 * @internal Exported for unit tests.
 */
export const pickProbeRecoveryActions = pickFromShared;
