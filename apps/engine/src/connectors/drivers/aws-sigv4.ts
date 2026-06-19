// AWS Signature Version 4 — generic request signer for the HTTP / GraphQL
// drivers. Wraps `aws4` so any AWS service (AppSync IAM, DynamoDB, API
// Gateway IAM, EventBridge, etc.) can ride the standard request
// pipeline without a per-service driver.
//
// The credential carries identity (`access_key_id`, `secret_access_key`,
// optional `session_token` from STS / IAM Identity Center). The
// connector config carries endpoint metadata (`aws_region`,
// `aws_service`).
//
// Signing happens AFTER the URL / headers / body are built (the
// canonical request includes all of them) and BEFORE dispatch. The
// signer mutates a header bag in place rather than the URL.

import aws4 from "aws4";
import type { AwsSigV4CredentialValue } from "../../credentials/types.ts";
import { HttpRequestInvalidError } from "./http.ts";

export interface SigV4SignParams {
  method: string;
  url: URL;
  /** Header bag — mutated in place with `Authorization`, `X-Amz-*`, etc. */
  headers: Record<string, string>;
  body?: string | undefined;
  /** Connector config — `aws_region` + `aws_service` resolved by the
   *  driver from `connector.config`. `aws_service` is required (e.g.
   *  `appsync`, `execute-api`, `dynamodb`, `s3`); `aws_region` defaults
   *  to `us-east-1` if not set, matching the AWS SDK default. */
  region: string;
  service: string;
  credential: AwsSigV4CredentialValue;
}

// AWS region / service tokens — RFC-style identifier. Tightening the
// shape lets us throw a typed `request_invalid` error before `aws4`
// gets a chance to fail with a generic Error that the request-step
// retry loop misclassifies as a transient connection error and
// retries 5×. (Audit anti-pattern E1, conversation 730c568a.)
const AWS_REGION_RE = /^[a-z0-9-]+$/i;
const AWS_SERVICE_RE = /^[a-z0-9-]+$/i;

/** Apply SigV4 signing to a request. Mutates `params.headers` to
 *  include `Authorization`, `X-Amz-Date`, `X-Amz-Content-Sha256`, and
 *  optionally `X-Amz-Security-Token`. Idempotent — safe to call once
 *  per request even after retries. */
export function signSigV4Request(params: SigV4SignParams): void {
  if (!params.region || !AWS_REGION_RE.test(params.region)) {
    throw new HttpRequestInvalidError(
      `aws_region "${params.region}" is empty or not a valid AWS region token`,
      "config.aws_region",
    );
  }
  if (!params.service || !AWS_SERVICE_RE.test(params.service)) {
    throw new HttpRequestInvalidError(
      `aws_service "${params.service}" is empty or not a valid AWS service token`,
      "config.aws_service",
    );
  }
  if (!params.credential.access_key_id) {
    throw new HttpRequestInvalidError(
      "aws_sigv4 credential is missing access_key_id",
      "credential.access_key_id",
    );
  }
  if (!params.credential.secret_access_key) {
    throw new HttpRequestInvalidError(
      "aws_sigv4 credential is missing secret_access_key",
      "credential.secret_access_key",
    );
  }
  const u = params.url;
  // aws4 expects host + path + headers + body as fields on a single
  // options bag; it returns a clone with the auth headers attached.
  const opts: aws4.Request = {
    host: u.host,
    method: params.method,
    path: `${u.pathname}${u.search}`,
    headers: { ...params.headers, host: u.host },
    region: params.region,
    service: params.service,
  };
  if (params.body !== undefined) {
    opts.body = params.body;
  }
  const signed = aws4.sign(opts, {
    accessKeyId: params.credential.access_key_id,
    secretAccessKey: params.credential.secret_access_key,
    ...(params.credential.session_token ? { sessionToken: params.credential.session_token } : {}),
  });
  // Lift signed headers back onto the caller's bag. `aws4` returns a
  // mixed-case map (Authorization, X-Amz-Date, X-Amz-Content-Sha256,
  // X-Amz-Security-Token); preserve casing — some AWS endpoints are
  // strict about it.
  const signedHeaders = (signed.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(signedHeaders)) {
    if (k.toLowerCase() === "host") continue; // fetch() rejects manual Host
    params.headers[k] = String(v);
  }
}
