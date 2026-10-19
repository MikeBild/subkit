import { createHash } from "node:crypto";
import { type S3Client, S3Errors } from "@bradenmacdonald/s3-lite-client";
import { fetchWithEgressGuard } from "../egress-fetch.ts";
import type { EgressGuardContext } from "../egress-guard.ts";
import { signSigV4Request } from "./aws-sigv4.ts";
import { getDriverFetch } from "./fetch-seam.ts";
import { checkAuthorityRedirect, readBodyBytesCapped, resolveMaxResponseBytes } from "./http.ts";
import type { S3Credentials } from "./s3.ts";

export async function makeGuardedS3Request(params: {
  client: S3Client;
  bucket: string;
  options: Parameters<S3Client["makeRequest"]>[0];
  credentials: S3Credentials | null;
  context: EgressGuardContext;
  onCredentialUse?: (() => Promise<void>) | undefined;
}): Promise<Response> {
  const { client, bucket, options, credentials, context } = params;
  const host = client.pathStyle ? client.host : `${bucket}.${client.host}`;
  const base = client.pathStyle
    ? `${client.pathPrefix}/${bucket}/${options.objectName}`
    : `/${options.objectName}`;
  const query =
    typeof options.query === "string"
      ? options.query
      : new URLSearchParams(options.query).toString();
  const path = base.split("/").map(encodeURIComponent).join("/");
  const target = new URL(`${client.protocol}//${host}${path}${query ? `?${query}` : ""}`);
  const headers = Object.fromEntries(new Headers(options.headers));
  let body: Uint8Array | undefined;
  if (["POST", "PUT", "DELETE"].includes(options.method)) {
    body =
      typeof options.payload === "string"
        ? new TextEncoder().encode(options.payload)
        : new Uint8Array(options.payload ?? []);
    headers["content-length"] = String(body.byteLength);
  } else if (options.payload) {
    throw new Error(`Unexpected payload on ${options.method} request`);
  }
  headers["x-amz-content-sha256"] = createHash("sha256")
    .update(body ?? new Uint8Array())
    .digest("hex");
  if (credentials) {
    signSigV4Request({
      method: options.method,
      url: target,
      headers,
      region: client.region,
      service: "s3",
      credential: {
        access_key_id: credentials.access_key_id,
        secret_access_key: credentials.secret_access_key,
        ...(credentials.session_token ? { session_token: credentials.session_token } : {}),
      },
    });
  }
  await params.onCredentialUse?.();
  const response = await fetchWithEgressGuard(
    target,
    {
      method: options.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      ...(body ? { body: new Uint8Array(body).buffer } : {}),
    },
    context,
    { fetchImpl: getDriverFetch() },
  );
  await checkAuthorityRedirect(response, { redirect: "manual" });
  if (response.status !== (options.statusCode ?? 200)) {
    if (response.status >= 400) throw await S3Errors.parseServerError(response);
    throw new S3Errors.ServerError(
      response.status,
      "UnexpectedStatusCode",
      "Unexpected S3 response status",
    );
  }
  if (!options.returnBody) {
    await readBodyBytesCapped(response, resolveMaxResponseBytes(context.tenant_id), "S3 response");
  }
  return response;
}
