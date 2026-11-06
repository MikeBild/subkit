import type { DecryptedCredential } from "../../credentials/types.ts";
import type { ConnectorView } from "../types.ts";

export type AppliedAuthMethod =
  | "none"
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2_static"
  | "oauth2_refreshed"
  | "aws_sigv4"
  | "token_mint_static"
  | "token_mint_refreshed"
  | "signed_jwt";

export interface HeaderViolation {
  message: string;
  field: string;
}

const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function outboundHeaderViolation(headers: unknown): HeaderViolation | null {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return {
      message: `headers must be a {string: string} record, got ${Array.isArray(headers) ? "array" : typeof headers}`,
      field: "headers",
    };
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!HTTP_HEADER_NAME_RE.test(name)) {
      return {
        message: `header name "${name}" is not an RFC 7230 token — fix the workflow's headers field`,
        field: `headers.${name}`,
      };
    }
    if (typeof value !== "string") {
      return {
        message: `header "${name}" must be a string, got ${typeof value}`,
        field: `headers.${name}`,
      };
    }
  }
  return null;
}

export function applyAuthMaterial(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
  headers: Record<string, string>,
  query: Record<string, string | number | boolean>,
): void {
  const cfg = (connector.config ?? {}) as {
    static_headers?: Record<string, string>;
    static_query?: Record<string, string>;
  };
  if (cfg.static_headers) {
    for (const [k, v] of Object.entries(cfg.static_headers)) {
      headers[k] = v;
    }
  }
  if (cfg.static_query) {
    for (const [k, v] of Object.entries(cfg.static_query)) {
      query[k] = v;
    }
  }
  if (!credential) {
    return;
  }
  switch (credential.mode) {
    case "header":
      for (const [k, v] of Object.entries(credential.headers)) {
        headers[k] = v;
      }
      return;
    case "query":
      for (const [k, v] of Object.entries(credential.query)) {
        query[k] = v;
      }
      return;
    case "bearer":
      headers.Authorization = `Bearer ${credential.token}`;
      return;
    case "basic": {
      const encoded = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
        "base64",
      );
      headers.Authorization = `Basic ${encoded}`;
      return;
    }
    case "oauth2": {
      if (!credential.access_token) return;
      const scheme = (credential.token_type ?? "").trim();
      if (scheme === "" || /^(none|no_prefix)$/i.test(scheme)) {
        headers.Authorization = credential.access_token;
      } else if (scheme.toLowerCase() === "bearer") {
        headers.Authorization = `Bearer ${credential.access_token}`;
      } else {
        headers.Authorization = `${scheme} ${credential.access_token}`;
      }
      return;
    }
    case "token_mint": {
      if (!credential.access_token) return;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: header_template is operator-supplied and ${token} is a literal placeholder, not a JS template
      const tpl = credential.header_template ?? "Bearer ${token}";
      // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal placeholder above
      headers.Authorization = tpl.replaceAll("${token}", credential.access_token);
      return;
    }
    case "oauth2_client":
      throw new Error(
        "oauth2_client credentials are not directly applied to HTTP requests — they identify the registered OAuth2 client and are consumed by the token endpoint flow.",
      );
    case "oauth2_private_key":
      throw new Error(
        "oauth2_private_key credentials are not directly applied to HTTP requests — they are consumed by the MCP client pool's PrivateKeyJwtProvider.",
      );
    default: {
      const unsignedMode: "none" | "aws_sigv4" | "signed_jwt" = credential.mode;
      void unsignedMode;
      return;
    }
  }
}

export function deriveAppliedAuthMethod(
  credential: DecryptedCredential | null,
  oauth2Refreshed: boolean,
): AppliedAuthMethod {
  if (!credential) return "none";
  switch (credential.mode) {
    case "none":
    case "oauth2_client":
    case "oauth2_private_key":
      return "none";
    case "bearer":
      return "bearer";
    case "header":
      return "header";
    case "query":
      return "query";
    case "basic":
      return "basic";
    case "oauth2":
      return oauth2Refreshed ? "oauth2_refreshed" : "oauth2_static";
    case "aws_sigv4":
      return "aws_sigv4";
    case "token_mint":
      return oauth2Refreshed ? "token_mint_refreshed" : "token_mint_static";
    case "signed_jwt":
      return "signed_jwt";
  }
}

export function resolveRespectRobots(configured: unknown, tenantDefault: boolean): boolean {
  return typeof configured === "boolean" ? configured : tenantDefault;
}

export function carriesRequestBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export function dropContentTypeHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers))
    if (name.toLowerCase() === "content-type") delete headers[name];
}

export interface InlineBodyPlan {
  body: string;
  content_type: "application/json" | null;
}

export function planInlineBody(
  method: string,
  body: unknown,
  headers: Record<string, string>,
): InlineBodyPlan | null {
  if (body === undefined || body === null || !carriesRequestBody(method)) return null;
  return {
    body: typeof body === "string" ? body : JSON.stringify(body),
    content_type: !headers["content-type"] && !headers["Content-Type"] ? "application/json" : null,
  };
}

export interface ManualRedirectPolicy {
  redirect: "manual";
}

export function effectiveDispatchPolicy(
  policy: ManualRedirectPolicy | undefined,
  signedJwt: boolean,
): ManualRedirectPolicy | undefined {
  return policy ?? (signedJwt ? { redirect: "manual" } : undefined);
}

export function isAuthorityRedirect(
  status: number,
  hasLocation: boolean,
  policy: ManualRedirectPolicy | undefined,
): boolean {
  return policy !== undefined && status >= 300 && status < 400 && hasLocation;
}

export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface SigV4Target {
  region: string;
  service: string;
}

export function resolveSigV4Target(config: unknown, connectorId: string): SigV4Target {
  const cfg = (config ?? {}) as { aws_region?: unknown; aws_service?: unknown };
  const region = typeof cfg.aws_region === "string" ? cfg.aws_region : "us-east-1";
  const service = typeof cfg.aws_service === "string" ? cfg.aws_service : null;
  if (!service) {
    throw new Error(`aws_sigv4 connector ${connectorId} missing required config.aws_service`);
  }
  return { region, service };
}

export function detectErrorReasonBody(
  body: unknown,
  reason: string,
): {
  matched: boolean;
  api_name?: string;
} {
  if (!body || typeof body !== "object") return { matched: false };
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return { matched: false };
  const errors = (err as { errors?: unknown }).errors;
  const reasonMatches = (val: unknown): boolean =>
    typeof val === "object" && val !== null && (val as { reason?: unknown }).reason === reason;
  if (Array.isArray(errors) && errors.some(reasonMatches)) {
    const message = (err as { message?: unknown }).message;
    const apiNameMatch =
      typeof message === "string" ? /\b([A-Z][A-Za-z]*?)\s+API\b/.exec(message) : null;
    const api_name = apiNameMatch?.[1];
    return api_name !== undefined ? { matched: true, api_name } : { matched: true };
  }
  return { matched: false };
}

export type ProbeStatusCode =
  | "credential_invalid"
  | "scope_insufficient"
  | "remote_resource_not_found"
  | "unknown_upstream_error";

export function canSignalApiDisabled(status: number): boolean {
  return status === 403 || status === 404 || status === 400;
}

export function probeStatusCode(status: number): ProbeStatusCode {
  if (status === 401) return "credential_invalid";
  if (status === 403) return "scope_insufficient";
  if (status === 404) return "remote_resource_not_found";
  return "unknown_upstream_error";
}

export function mergeProbeHeaders(
  inherited: Record<string, string>,
  configured: Record<string, string> | undefined,
): Record<string, string> {
  const headers = { ...inherited };
  for (const [name, value] of Object.entries(configured ?? {})) {
    const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (match) delete headers[match];
    headers[name] = value;
  }
  return headers;
}

export function shadowedProbeHeader(
  probeHeaders: Record<string, string> | undefined,
  credential: DecryptedCredential | null,
): string | null {
  if (!probeHeaders || credential?.mode !== "header") return null;
  const credentialNames = new Set(
    Object.keys(credential.headers).map((name) => name.toLowerCase()),
  );
  return Object.keys(probeHeaders).find((name) => credentialNames.has(name.toLowerCase())) ?? null;
}

export function probeTarget(config: { method: string; path: string } | null): {
  method: string;
  path_or_url: string;
} {
  return {
    method: config?.method ?? "GET",
    path_or_url: config !== null && config.path !== "" ? config.path : "/",
  };
}

export interface ProbeVerdict {
  ok: boolean;
  warning_only: boolean;
  unverified_fallback: boolean;
  warnings: Array<{ code: string; message: string }>;
}

export function probeVerdict(
  status: number,
  expected: readonly [number, number] | null,
  hasCredential: boolean,
): ProbeVerdict {
  if (expected !== null) {
    const [lo, hi] = expected;
    return {
      ok: status >= lo && status <= hi,
      warning_only: false,
      unverified_fallback: false,
      warnings: [],
    };
  }
  if (status === 404 || status === 405) {
    return {
      ok: true,
      warning_only: true,
      unverified_fallback: false,
      warnings: [
        {
          code: "PROBE_AMBIGUOUS",
          message: `Fallback probe GET / returned ${status}; connectivity likely OK but endpoint unknown.`,
        },
      ],
    };
  }
  if (status === 401 || status === 403) {
    return { ok: false, warning_only: false, unverified_fallback: hasCredential, warnings: [] };
  }
  return { ok: status < 500, warning_only: false, unverified_fallback: false, warnings: [] };
}

export function unverifiedProbeWarning(status: number): { code: string; message: string } {
  return {
    code: "PROBE_AUTH_UNVERIFIED",
    message: `Fallback probe GET / returned ${status}: the root path requires sign-in, so the credential was not verified. Set config.probe_endpoint to a cheap authenticated read.`,
  };
}
