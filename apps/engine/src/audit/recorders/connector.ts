// Connector audit recorders.
//
// Every Wave-1..3 state-changing path against a connector lands here:
//   - createConnector → recordConnectorCreated
//   - updateConnector / save_connector_draft re-issue → recordConnectorUpdated
//   - deleteConnector → recordConnectorDeleted
//   - call_connector / probe_connector → recordConnectorInvoked
//   - save_connector_draft with force_save → recordConnectorSavedOverride
//   - update_connector_draft credential rejection → recordConnectorDraftCredentialRejected
//
// The metadata shape is locked at the recorder level so a schema drift
// in one call site cannot silently desynchronise the audit trail.

import { audit, auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import {
  type AuditOutcome,
  type RecordedEntry,
  type RecorderBase,
  resolveActorType,
} from "./types.ts";

export interface RecordConnectorCreatedParams extends RecorderBase {
  connector_id: string;
  slug: string;
  driver: string;
  environment: string;
  /** Free-form reason; defaults to "manual_re_issue" when null. */
  reason: string;
  /** Tags the dispatch path: tool re-issue vs harness auto-persist. */
  source: "harness_auto_persist" | "tool_call";
  credential_persisted?: boolean;
  /** When auto-persisted, the carrier elicitation kind. */
  commit_intent_kind?: string;
}

export async function recordConnectorCreated(
  p: RecordConnectorCreatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_CREATED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        slug: p.slug,
        driver: p.driver,
        environment: p.environment,
        ...(p.credential_persisted !== undefined
          ? { credential_persisted: p.credential_persisted }
          : {}),
        ...(p.commit_intent_kind ? { commit_intent_kind: p.commit_intent_kind } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorUpdatedParams extends RecorderBase {
  connector_id: string;
  /** "credential_rotated" | "create_via_tool" | "auto_persist" — surfaced verbatim. */
  kind: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call";
  environment?: string;
  credential_mode?: string;
  credential_persisted?: boolean;
  /** Idempotent re-issue against an already-persisted connector. */
  idempotent?: boolean;
  commit_intent_kind?: string;
  tool?: string;
}

export async function recordConnectorUpdated(
  p: RecordConnectorUpdatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_UPDATED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        kind: p.kind,
        ...(p.environment ? { environment: p.environment } : {}),
        ...(p.credential_mode ? { credential_mode: p.credential_mode } : {}),
        ...(p.credential_persisted !== undefined
          ? { credential_persisted: p.credential_persisted }
          : {}),
        ...(p.idempotent !== undefined ? { idempotent: p.idempotent } : {}),
        ...(p.tool ? { tool: p.tool } : {}),
        ...(p.commit_intent_kind ? { commit_intent_kind: p.commit_intent_kind } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorDeletedParams extends RecorderBase {
  connector_id: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
  slug?: string;
}

export async function recordConnectorDeleted(
  p: RecordConnectorDeletedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_DELETED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        ...(p.slug ? { slug: p.slug } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorInvokedParams extends RecorderBase {
  connector_id: string;
  connector_slug: string;
  driver: string;
  environment: string;
  method: string;
  path: string;
  url_host: string;
  status_code: number;
  latency_ms: number;
  /** "error" rows ALSO get audited — the call happened, only the upstream failed. */
  outcome: AuditOutcome;
  conversation_id?: string;
}

export async function recordConnectorInvoked(
  p: RecordConnectorInvokedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_INVOKED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: p.outcome,
      reason: "tool_invocation",
      metadata: {
        ...(p.conversation_id ? { conversation_id: p.conversation_id } : {}),
        connector_id: p.connector_id,
        connector_slug: p.connector_slug,
        driver: p.driver,
        environment: p.environment,
        method: p.method,
        path: p.path,
        url_host: p.url_host,
        status_code: p.status_code,
        latency_ms: p.latency_ms,
      },
    },
    p.executor,
  );
}

export interface RecordConnectorSavedOverrideParams extends RecorderBase {
  connector_id: string;
  slug: string;
  driver: string;
  environment: string;
  /** Why the operator forced past the failing probe (audit trail). */
  reason: string;
  /** Latest probe envelope captured BEFORE the override. */
  latest_probe: unknown | null;
  source: "harness_auto_persist" | "tool_call";
  tool?: string;
  probe_failure_code?: string | null;
  /**
   * Override the metadata `kind` tag. Defaults to "force_save_override"
   * (the canonical marker). The tool path passes "probe_override"
   * when the row is the tool's secondary audit alongside the atomic
   * helper's force_save_override row, so operators can tell the two
   * paths apart.
   */
  kind?: string;
  /** True when the save overrode a failed probe via force_save. */
  forced?: boolean;
  /**
   * True when the fresh-probe force_save cooldown was bypassed by a
   * resolved operator approval (commit-intent dispatch). A bare
   * LLM-initiated force_save never sets this — the cooldown refuses it.
   */
  cooldown_bypassed?: boolean;
}

export async function recordConnectorSavedOverride(
  p: RecordConnectorSavedOverrideParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_SAVED_OVERRIDE,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        kind: p.kind ?? "force_save_override",
        slug: p.slug,
        driver: p.driver,
        environment: p.environment,
        latest_probe: p.latest_probe ?? null,
        ...(p.tool ? { tool: p.tool } : {}),
        ...(p.probe_failure_code !== undefined ? { probe_failure_code: p.probe_failure_code } : {}),
        ...(p.forced !== undefined ? { forced: p.forced } : {}),
        ...(p.cooldown_bypassed !== undefined ? { cooldown_bypassed: p.cooldown_bypassed } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorDiscoveredParams extends RecorderBase {
  connector_id: string;
  /** Strategy that produced the result (openapi-direct, graphql-introspect, …). */
  strategy: string;
  /** Cache key the discovery dispatcher used (template:slug or url:hash). */
  cache_key: string;
  /** "cache" when the result was served from `knowledge_sources`, "fresh"
   *  when the strategy chain ran. */
  source: "cache" | "fresh";
  endpoint_count: number;
  /** Per-strategy warnings accumulated by the dispatcher — surfaced verbatim
   *  so operators can see "openapi-direct 404, llms.txt empty,
   *  html-scrape succeeded". */
  warnings: ReadonlyArray<{ code: string; message: string }>;
}

export async function recordConnectorDiscovered(
  p: RecordConnectorDiscoveredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_DISCOVERED,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: null,
      metadata: {
        strategy: p.strategy,
        cache_key: p.cache_key,
        source: p.source,
        endpoint_count: p.endpoint_count,
        warning_count: p.warnings.length,
        ...(p.warnings.length > 0 ? { warnings: p.warnings.slice(0, 25) } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordConnectorDraftCredentialRejectedParams extends RecorderBase {
  conversation_id: string;
  /**
   * Dotted path of the offending field in the draft `config`. Value is
   * intentionally NOT recorded — only the path is safe to surface.
   */
  matched_key_path: string;
  /**
   * Policy discriminator. Defaults to `credential_must_use_form` (a
   * credential-shaped value smuggled into config). The query-auth
   * param-name guard passes `auth_param_name_in_config` so operators
   * tailing `audit_log` can tell the two rejection classes apart.
   */
  reason?: "credential_must_use_form" | "auth_param_name_in_config";
}

/**
 * Credential-rejection rows are emitted from the rejection branch
 * BEFORE any DB mutation, so the recorder uses the fire-and-forget
 * `audit()` form. A failed audit insert (e.g. malformed tenant_id in a
 * unit-test stub context) MUST NOT propagate as a tool-level error —
 * the rejection envelope returned to the LLM is the user-facing
 * contract. Tests that assert on the audit row pass an `executor` and
 * await the underlying row appearance via SELECT.
 */
export function recordConnectorDraftCredentialRejected(
  p: RecordConnectorDraftCredentialRejectedParams,
): RecordedEntry {
  return audit(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "denied",
      reason: p.reason ?? "credential_must_use_form",
      metadata: {
        conversation_id: p.conversation_id,
        matched_key_path: p.matched_key_path,
      },
    },
    p.executor,
  );
}
