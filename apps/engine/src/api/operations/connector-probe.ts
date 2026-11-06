import { z } from "@hono/zod-openapi";
import { recordConnectorProbed } from "../../audit/recorders/connector.ts";
import { AuditAction } from "../../audit/types.ts";
import { withMcpConfigDefaults } from "../../connectors/config-schemas.ts";
import { probeConnector } from "../../connectors/drivers/index.ts";
import { computeConnectorScopeDiff } from "../../connectors/oauth-scope-diff.ts";
import { restoreMaskedConnectorSecrets } from "../../connectors/public-view.ts";
import { getConnector, getConnectorForDefinition } from "../../connectors/service.ts";
import {
  type ConnectorView,
  CreateConnectorSchema,
  type DriverName,
} from "../../connectors/types.ts";
import { can } from "../../rbac/evaluator.ts";
import { UNDESCRIBED_METADATA } from "../catalog-metadata.ts";
import { IdParam } from "../common-schemas.ts";
import { CredentialBody, credentialValueOf } from "./connector-credentials.ts";
import { defineOperation, isRejection, reject } from "./index.ts";

const ProbeErrorCodeEnum = z
  .enum([
    "credential_missing",
    "credential_invalid",
    "credential_expired",
    "credential_unverified",
    "scope_insufficient",
    "remote_api_disabled",
    "remote_resource_not_found",
    "connector_disabled",
    "unknown_upstream_error",
  ])
  .openapi("ProbeErrorCode");

const ProbeResultSchema = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number(),
    status: z.number().optional(),
    detail: z.string().optional(),
    error_code: ProbeErrorCodeEnum.optional(),
    provider_action_url: z.string().optional(),
    warning_only: z.boolean().optional(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
    partial_grant: z.union([z.boolean(), z.literal("unknown")]).optional(),
    granted_scopes: z.array(z.string()).optional(),
    expected_scopes: z.array(z.string()).optional(),
    missing_scopes: z.array(z.string()).optional(),
    partial_grant_note: z.string().optional(),
  })
  .openapi("ConnectorProbeResult");

const ProbeConnectorBody = z
  .object({
    connector: CreateConnectorSchema.describe(
      "The definition to probe, exactly as you would save it",
    ),
    credential: CredentialBody.optional().describe(
      "Credential to sign the probe with. Used for this request only and never stored. Required when the definition sets an auth_type other than 'none'.",
    ),
  })
  .openapi("ProbeConnectorBody");

const ProbeConnectorResponse = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number(),
    status: z.number().optional(),
    detail: z.string().optional(),
    error_code: z.string().optional(),
    body_snippet: z.string().optional(),
    provider_action_url: z.string().optional(),
  })
  .openapi("ProbeConnectorResponse");

type ProbeOutcome = Awaited<ReturnType<typeof probeConnector>>;
type ProbeBody = z.infer<typeof ProbeConnectorBody>;

function draftConnectorView(input: z.infer<typeof CreateConnectorSchema>): ConnectorView {
  return {
    id: "unsaved",
    tenant_id: "",
    slug: input.slug ?? "unsaved",
    display_name: input.name,
    ...UNDESCRIBED_METADATA,
    driver: input.driver as DriverName,
    environment: input.environment ?? "dev",
    auth_type: input.auth_type ?? "none",
    base_url: input.base_url ?? null,
    dsn: input.dsn ?? null,
    config: withMcpConfigDefaults(
      input.driver as DriverName,
      input.auth_type ?? "none",
      input.config as Record<string, unknown> | undefined,
    ),
    operator_quirks: (input.operator_quirks ?? {}) as ConnectorView["operator_quirks"],
    template_slug: input.template_slug ?? null,
    template_name: null,
    template_source: input.template_source ?? null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    created_at: new Date(),
    updated_at: new Date(),
    enabled: true,
    last_error: null,
    circuit_state: "closed",
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
}

export const testConnectorOperation = defineOperation<{ readonly id: string }, ProbeOutcome>({
  id: "connector.test",
  summary: "Probe a connector's health",
  permission: "connector:test",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_INVOKED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const actor_type = principal.kind === "user" ? "user" : "system_account";
    const connector = await getConnector(scope.tenant_id, id, scope.db);
    if (!connector) return reject.notFound("connector");
    const result = await probeConnector({
      db: scope.db,
      tenant_id: scope.tenant_id,
      connector,
      actor_id: principal.id,
      actor_type,
    });
    await recordConnectorProbed({
      tenant_id: scope.tenant_id,
      actor_id: principal.id,
      actor_type,
      executor: scope.db,
      connector,
      result,
    });
    const scopeDiff = await computeConnectorScopeDiff(scope.db, scope.tenant_id, connector);
    return {
      ...result,
      ...(scopeDiff
        ? {
            partial_grant: scopeDiff.partial_grant,
            granted_scopes: scopeDiff.granted,
            expected_scopes: scopeDiff.expected,
            ...(scopeDiff.missing.length > 0 ? { missing_scopes: scopeDiff.missing } : {}),
            ...(scopeDiff.note ? { partial_grant_note: scopeDiff.note } : {}),
          }
        : {}),
    };
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/test",
    tags: ["connectors"],
    params: IdParam,
    response: ProbeResultSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (result) => result,
  },
});

export const probeConnectorDefinitionOperation = defineOperation<ProbeBody, ProbeOutcome>({
  id: "connector.probe_definition",
  summary: "Probe a connector definition without saving it",
  permission: "connector:test",
  effect: "read",
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const saved = await getConnectorForDefinition(scope.tenant_id, body.connector, scope.db);
    const mayUseSaved =
      saved !== null &&
      (
        await can(scope.db, {
          tenant_id: scope.tenant_id,
          principal,
          permission: "connector:test",
          resource: { type: "connector", id: saved.id },
        })
      ).allow;
    const draft = draftConnectorView(body.connector);
    const secrets = restoreMaskedConnectorSecrets(
      {
        base_url: draft.base_url,
        config: draft.config,
        ...(draft.dsn !== null ? { dsn: draft.dsn } : {}),
      },
      mayUseSaved ? saved : null,
    );
    const connector: ConnectorView = {
      ...draft,
      base_url: secrets.base_url ?? null,
      config: secrets.config ?? {},
      dsn: secrets.dsn ?? null,
    };
    const credential = body.credential ? credentialValueOf(body.credential) : null;
    if (isRejection(credential)) return credential;
    return probeConnector({
      db: scope.db,
      tenant_id: scope.tenant_id,
      connector: { ...connector, tenant_id: scope.tenant_id },
      credential_override: credential,
      actor_id: principal.id,
      actor_type: principal.kind === "user" ? "user" : "system_account",
    });
  },
  http: {
    method: "post",
    path: "/v1/connectors/probe",
    tags: ["connectors"],
    description:
      "Runs the driver's health probe against a definition as it would be saved. Persists nothing — neither the connector nor the credential. `sk connectors probe --file` calls this. A definition read back from the API may carry the mask `***redacted***`: it stands for the secret stored on the connector with the same slug and environment, as it does on a write. For driver `mcp`, the probe performs a throwaway initialize + tools/list handshake with the supplied static credential and closes the session immediately.",
    body: ProbeConnectorBody,
    response: ProbeConnectorResponse,
    success: {
      status: 200,
      description: "Probe outcome — check `ok`; an unreachable upstream is still a 200",
    },
    errors: {
      400: "The request cannot be served because the credential or connector definition is malformed. Distinct from a 200 `ok:false`, which means the upstream was reached and answered badly.",
      422: "The definition carries the redaction mask `***redacted***` where no stored secret can stand for it: no connector with this slug and environment exists, or the definition points somewhere other than the stored connector does. Send the real value.",
    },
    toInput: ({ json }) => json as ProbeBody,
    toBody: (result) => result,
  },
});
