import { getCredentialForConnector } from "../../../credentials/service.ts";
import type { DecryptedCredential } from "../../../credentials/types.ts";
import type { Db } from "../../../db/client.ts";
import { log } from "../../../logging/logger.ts";
import {
  canSignalApiDisabled,
  detectErrorReasonBody,
  mergeProbeHeaders,
  probeStatusCode,
  probeTarget,
  probeVerdict,
  shadowedProbeHeader,
  unverifiedProbeWarning,
} from "../../core/http-request.ts";
import {
  getConnectorProbeDiagnostics,
  getConnectorProbeEndpoint,
  serviceHostMatches,
} from "../../template-binding.ts";
import { type ProbeEndpoint, ProbeEndpointSchema } from "../../templates.ts";
import type { ConnectorView } from "../../types.ts";
import { buildProbeDiagnostics } from "../probe-diagnostics.ts";
import { HttpRequestInvalidError } from "../response-body.ts";
import { executeConnectorHttpRequest } from "./connector-request.ts";

interface HttpProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  warning_only: boolean;
  warnings: Array<{ code: string; message: string }>;
  error_code?:
    | "credential_missing"
    | "credential_invalid"
    | "credential_expired"
    | "credential_unverified"
    | "scope_insufficient"
    | "remote_api_disabled"
    | "remote_resource_not_found"
    | "unknown_upstream_error";
  provider_action_url?: string;
  body_snippet?: string;
  response_headers?: Record<string, string>;
}

function apiDisabledActionUrl(
  connector: ConnectorView,
  diagnostic: { service_host: string; action_url: string },
  api_name?: string,
): string | undefined {
  let service: string | undefined;
  if (api_name) {
    service = diagnostic.service_host.replace("{api}", api_name.toLowerCase());
  } else if (typeof connector.base_url === "string" && connector.base_url.length > 0) {
    try {
      const host = new URL(connector.base_url).hostname.toLowerCase();
      if (serviceHostMatches(diagnostic.service_host, host)) service = host;
    } catch {
      service = undefined;
    }
  }
  if (!service) return undefined;
  return diagnostic.action_url.replace("{service}", service);
}

export function classifyHttpProbeStatus(
  status: number,
  connector: ConnectorView,
  body?: unknown,
): { code: HttpProbeResult["error_code"]; provider_action_url?: string } {
  const apiDisabled = getConnectorProbeDiagnostics(connector)?.remote_api_disabled;
  if (canSignalApiDisabled(status) && body !== undefined && apiDisabled) {
    const detected = detectErrorReasonBody(body, apiDisabled.error_reason);
    if (detected.matched) {
      const actionUrl = apiDisabledActionUrl(connector, apiDisabled, detected.api_name);
      return {
        code: "remote_api_disabled",
        ...(actionUrl ? { provider_action_url: actionUrl } : {}),
      };
    }
  }
  return { code: probeStatusCode(status) };
}

export function resolveProbeEndpointConfig(connector: ConnectorView): ProbeEndpoint | null {
  const raw = getConnectorProbeEndpoint(connector);
  if (raw === null || raw === undefined) return null;
  const parsed = ProbeEndpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpRequestInvalidError(
      `invalid connector probe_endpoint: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      "config.probe_endpoint",
    );
  }
  const config = parsed.data;
  const templateRaw = getConnectorProbeEndpoint({
    ...connector,
    config: {},
  });
  const template = ProbeEndpointSchema.safeParse(templateRaw);
  if (
    !template.success ||
    template.data.method !== config.method ||
    template.data.path !== config.path ||
    !template.data.headers
  )
    return config;
  return { ...config, headers: mergeProbeHeaders(template.data.headers, config.headers) };
}

function assertProbeHeadersDoNotShadowCredential(
  config: ProbeEndpoint | null,
  credential: DecryptedCredential | null,
): void {
  const shadowed = shadowedProbeHeader(config?.headers, credential);
  if (shadowed) {
    throw new HttpRequestInvalidError(
      `probe header "${shadowed}" is supplied by the saved credential`,
      `config.probe_endpoint.headers.${shadowed}`,
    );
  }
}

async function resolveProbeCredential(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
}): Promise<{ value: DecryptedCredential } | null | undefined> {
  if (p.credential_override !== undefined) {
    return p.credential_override && { value: p.credential_override };
  }
  return getCredentialForConnector(p.tenant_id, p.connector.id, p.connector.environment, p.db);
}

export async function probeHttpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
}): Promise<HttpProbeResult> {
  const start = Date.now();
  try {
    if (!p.connector.base_url) {
      return {
        ok: false,
        latency_ms: 0,
        detail: "connector has no base_url",
        warning_only: false,
        warnings: [],
      };
    }

    let probeCredential: DecryptedCredential | null = null;
    if (p.connector.auth_type !== "none") {
      const credRow = await resolveProbeCredential(p);
      if (!credRow) {
        return {
          ok: false,
          latency_ms: 0,
          detail:
            "credential_required: probe requires a saved credential — collect one via ask_user_form and persist via save_connector_draft({credential})",
          warning_only: false,
          warnings: [
            {
              code: "CREDENTIAL_REQUIRED",
              message: "draft has no attached credential; cannot probe",
            },
          ],
          error_code: "credential_missing",
        };
      }
      probeCredential = credRow.value;
    }

    const probeConfig = resolveProbeEndpointConfig(p.connector);
    assertProbeHeadersDoNotShadowCredential(probeConfig, probeCredential);

    const target = probeTarget(probeConfig);

    const res = await executeConnectorHttpRequest({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      method: target.method,
      path_or_url: target.path_or_url,
      ...(probeConfig?.headers ? { headers: probeConfig.headers } : {}),
      ...(p.credential_override !== undefined
        ? { credential_override: p.credential_override }
        : {}),
    });

    const latency_ms = Date.now() - start;
    const verdict = probeVerdict(
      res.status,
      probeConfig !== null ? (probeConfig.expected_status ?? [200, 299]) : null,
      probeCredential !== null,
    );
    const warnings = [...verdict.warnings];

    const result: HttpProbeResult = {
      ok: verdict.ok,
      latency_ms,
      status: res.status,
      warning_only: verdict.warning_only,
      warnings,
    };
    if (!verdict.ok) {
      const classification = classifyHttpProbeStatus(res.status, p.connector, res.body);
      if (verdict.unverified_fallback && classification.code !== "remote_api_disabled") {
        result.error_code = "credential_unverified";
        result.warning_only = true;
        warnings.push(unverifiedProbeWarning(res.status));
      } else if (classification.code) {
        result.error_code = classification.code;
      }
      if (classification.provider_action_url) {
        result.provider_action_url = classification.provider_action_url;
      }
      Object.assign(result, buildProbeDiagnostics(res.headers, res.body));
    }
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms,
      status: res.status,
    });
    return result;
  } catch (err) {
    const result: HttpProbeResult = {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      warning_only: false,
      warnings: [],
    };
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms: result.latency_ms,
      detail: result.detail,
    });
    return result;
  }
}
