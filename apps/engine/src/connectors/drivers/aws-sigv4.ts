import aws4 from "aws4";
import type { AwsSigV4CredentialValue } from "../../credentials/types.ts";
import { HttpRequestInvalidError } from "./http.ts";

export interface SigV4SignParams {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | Buffer | undefined;
  region: string;
  service: string;
  credential: AwsSigV4CredentialValue;
}

const AWS_REGION_RE = /^[a-z0-9-]+$/i;
const AWS_SERVICE_RE = /^[a-z0-9-]+$/i;

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
  const signedHeaders = (signed.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(signedHeaders)) {
    if (k.toLowerCase() === "host") continue;
    params.headers[k] = String(v);
  }
}
