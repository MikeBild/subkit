import { getConfig, isConfigLoaded } from "../../../config/loader.ts";
import type { AwsSigV4CredentialValue, DecryptedCredential } from "../../../credentials/types.ts";
import type { Executor } from "../../../db/client.ts";
import { instrument } from "../../../observability/runtime-telemetry.ts";
import {
  carriesRequestBody,
  dropContentTypeHeaders,
  effectiveDispatchPolicy,
  isAuthorityRedirect,
  isSuccessStatus,
  outboundHeaderViolation,
  planInlineBody,
} from "../../core/http-request.ts";
import { injectTraceContext } from "../../egress.ts";
import { fetchWithEgressGuard } from "../../egress-fetch.ts";
import { assertEgressAllowedResolved } from "../../egress-guard.ts";
import type { ConnectorView } from "../../types.ts";
import { settleOnAbort } from "../abort-boundary.ts";
import { signSigV4Request } from "../aws-sigv4.ts";
import { getDriverFetch } from "../fetch-seam.ts";
import { shouldPromoteToFile } from "../file-promotion.ts";
import { multipartObservationHeaders, prepareMultipartBody } from "../http-multipart.ts";
import { HttpRequestInvalidError, readBodyBytesCapped } from "../response-body.ts";
import { applySignedJwtAuth, redactSignedJwtResponse } from "./auth.ts";
import { parseResponseBody } from "./body.ts";
import type {
  HttpDispatchObservation,
  HttpExecutionResult,
  RequestDispatchPolicy,
} from "./types.ts";

export const FETCH_DEADLINE_MS = 60_000;

const DEFAULT_MAX_RESPONSE_BYTES = 104_857_600;

export function resolveMaxResponseBytes(tenant_id?: string): number {
  return isConfigLoaded()
    ? getConfig(tenant_id).connectors.http.max_response_bytes
    : DEFAULT_MAX_RESPONSE_BYTES;
}

export function validateOutboundHeaders(headers: unknown): void {
  const violation = outboundHeaderViolation(headers);
  if (violation) throw new HttpRequestInvalidError(violation.message, violation.field);
}

export class AuthorityDispatchError extends Error {
  readonly code = "authority_invalid";
  constructor() {
    super("The redirect target requires separate authorization; no redirect was followed.");
    this.name = "AuthorityDispatchError";
  }
}

export async function checkAuthorityRedirect(
  response: Response,
  policy: RequestDispatchPolicy | undefined,
): Promise<void> {
  if (isAuthorityRedirect(response.status, response.headers.has("location"), policy)) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new AuthorityDispatchError();
  }
}

export async function executePlannedHttpRequest(params: {
  exec: Executor;
  before_dispatch?: (
    request: HttpDispatchObservation,
  ) => Promise<RequestDispatchPolicy | undefined>;
  tenant_id: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  multipartBody?: FormData;
  signal: AbortSignal;
  sigv4?: {
    region: string;
    service: string;
    credential: AwsSigV4CredentialValue;
  };
  signed_jwt?: {
    connector: ConnectorView;
    credential: Extract<DecryptedCredential, { mode: "signed_jwt" }>;
  };
  capture_binary?: boolean;
}): Promise<HttpExecutionResult> {
  validateOutboundHeaders(params.headers);

  const headers = { ...params.headers };
  const init: RequestInit = {
    method: params.method,
    headers,
    signal: params.signal,
  };
  let multipart: Awaited<ReturnType<typeof prepareMultipartBody>> | undefined;
  if (params.multipartBody !== undefined && carriesRequestBody(params.method)) {
    dropContentTypeHeaders(headers);
    multipart = await prepareMultipartBody(params.multipartBody);
    headers["content-type"] = multipart.contentType;
    init.body = multipart.body;
  } else {
    const inline = planInlineBody(params.method, params.body, headers);
    if (inline) {
      init.body = inline.body;
      if (inline.content_type) headers["content-type"] = inline.content_type;
    }
  }
  injectTraceContext(headers);
  if (params.sigv4) {
    signSigV4Request({
      method: params.method,
      url: params.url,
      headers,
      body: multipart
        ? Buffer.from(multipart.body)
        : typeof init.body === "string"
          ? init.body
          : undefined,
      region: params.sigv4.region,
      service: params.sigv4.service,
      credential: params.sigv4.credential,
    });
  }
  const dispatchPolicy = await params.before_dispatch?.({
    method: params.method,
    url: params.url.toString(),
    headers: multipart ? multipartObservationHeaders(params.headers) : params.headers,
    body: params.body ?? null,
    ...(multipart ? multipart.observation : {}),
  });
  const policy = effectiveDispatchPolicy(dispatchPolicy, params.signed_jwt !== undefined);
  if (policy) init.redirect = policy.redirect;
  let signedJwtToken: string | null = null;
  if (params.signed_jwt) {
    await assertEgressAllowedResolved(params.url, {
      tenant_id: params.tenant_id,
      exec: params.exec,
    });
    signedJwtToken = await applySignedJwtAuth(
      params.signed_jwt.connector,
      params.signed_jwt.credential,
      params.url,
      headers,
    );
  }
  const res = await instrument({
    module: "connector",
    action: "driver.http.request",
    level: "debug",
    thresholdMs: 1000,
    fields: { method: params.method, url_host: params.url.host },
    fn: () =>
      settleOnAbort(
        fetchWithEgressGuard(
          params.url,
          init,
          { tenant_id: params.tenant_id, exec: params.exec },
          {
            fetchImpl: getDriverFetch(),
          },
        ),
        params.signal,
      ),
  });
  const maxResponseBytes = resolveMaxResponseBytes(params.tenant_id);
  await checkAuthorityRedirect(res, policy);
  const buf = await readBodyBytesCapped(
    res,
    maxResponseBytes,
    params.url.toString(),
    params.signal,
  );
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerObj[k] = v;
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (
    params.capture_binary &&
    isSuccessStatus(res.status) &&
    shouldPromoteToFile({
      status: res.status,
      content_type: contentType,
      content_disposition: res.headers.get("content-disposition"),
      bytes: buf,
    })
  ) {
    return redactSignedJwtResponse(
      {
        status: res.status,
        headers: headerObj,
        body: undefined,
        body_raw: buf,
        bytes_in: buf.byteLength,
        url: params.url.toString(),
      },
      signedJwtToken,
    );
  }
  const text = buf.toString("utf8");
  return redactSignedJwtResponse(
    {
      status: res.status,
      headers: headerObj,
      body: parseResponseBody(text, contentType),
      bytes_in: buf.byteLength,
      url: params.url.toString(),
    },
    signedJwtToken,
  );
}
