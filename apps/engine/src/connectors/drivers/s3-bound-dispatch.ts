// Single-object S3 calls use the client's signer, but retain control of the
// actual dispatch so an approval cannot follow a redirect to a different target.
import type { S3Client } from "@bradenmacdonald/s3-lite-client";
import { assertEgressAllowedResolved } from "../egress-guard.ts";
import { getDriverFetch } from "./fetch-seam.ts";
import {
  checkAuthorityRedirect,
  type ResolvedConnectorCredential,
  readBodyBytesCapped,
  resolveMaxResponseBytes,
} from "./http.ts";
import type { executeS3Request, S3Response } from "./s3.ts";

export async function executeBoundS3Request(p: {
  client: S3Client;
  params: Parameters<typeof executeS3Request>[0];
  credential: Pick<
    ResolvedConnectorCredential,
    "credential_id" | "credential_revision" | "connection_authority"
  >;
}): Promise<S3Response> {
  const { params, client, credential } = p;
  const method = params.method;
  if (
    !["GET", "PUT", "HEAD", "DELETE"].includes(method) ||
    params.presignExpiresIn !== undefined ||
    params.paginate ||
    params.multipart ||
    params.range ||
    (params.body != null && typeof params.body !== "string" && !(params.body instanceof Uint8Array))
  ) {
    throw Object.assign(
      new Error("This S3 operation needs a supported concrete action boundary."),
      { code: "authority_unknown" },
    );
  }
  const headers: Record<string, string> = {};
  if (params.contentType) {
    if (/[\r\n]/.test(params.contentType)) throw new Error("Invalid S3 content type");
    headers["content-type"] = params.contentType;
  }
  for (const [key, value] of Object.entries(params.metadata ?? {})) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || /[\r\n]/.test(value))
      throw new Error("Invalid S3 metadata");
    headers[`x-amz-meta-${key.toLowerCase()}`] = value;
  }
  if (method !== "PUT" && Object.keys(headers).length)
    throw new Error("S3 object headers require PUT");
  if (method === "PUT" && params.body == null) throw new Error("s3 PUT requires a body");
  const verb = method as "GET" | "PUT" | "HEAD" | "DELETE";
  const key = params.path.replace(/^\//, "");
  let target: URL;
  if (client.accessKey) {
    // This URL remains in memory. It is never returned, logged or persisted.
    target = new URL(await client.getPresignedUrl(verb, key, { expirySeconds: 60 }));
  } else {
    const host = client.pathStyle ? client.host : `${client.defaultBucket}.${client.host}`;
    const path = client.pathStyle
      ? `${client.pathPrefix ?? ""}/${client.defaultBucket}/${key}`
      : `/${key}`;
    target = new URL(
      `${client.protocol}//${host}${path.split("/").map(encodeURIComponent).join("/")}`,
    );
  }
  await assertEgressAllowedResolved(target, { tenant_id: params.tenant_id });
  const signal = params.signal
    ? AbortSignal.any([params.signal, AbortSignal.timeout(params.timeout_ms ?? 30_000)])
    : AbortSignal.timeout(params.timeout_ms ?? 30_000);
  signal.throwIfAborted();
  const unsigned = new URL(target);
  unsigned.search = "";
  await params.before_dispatch?.(credential, {
    method: verb,
    url: unsigned.href,
    headers,
    body: typeof params.body === "string" ? params.body : null,
    ...(params.body instanceof Uint8Array ? { unsupported_body: true } : {}),
  });
  signal.throwIfAborted();
  const body =
    typeof params.body === "string"
      ? params.body
      : params.body instanceof Uint8Array
        ? new Uint8Array(params.body).buffer
        : null;
  const response = await getDriverFetch()(target, {
    method: verb,
    headers,
    redirect: "manual",
    signal,
    ...(verb === "PUT" ? { body } : {}),
  });
  await checkAuthorityRedirect(response, { redirect: "manual" });
  const buffer = await readBodyBytesCapped(
    response,
    resolveMaxResponseBytes(params.tenant_id),
    "bound S3 object",
    signal,
  );
  const responseHeaders = Object.fromEntries(response.headers.entries());
  if (verb === "HEAD" && response.status === 404)
    return {
      status: 404,
      headers: responseHeaders,
      body: null,
      credential_id: credential.credential_id,
    };
  if (!response.ok) throw new Error(`S3 request failed with status ${response.status}`);
  const etag = (responseHeaders.etag ?? "").replace(/^"(.*)"$/, "$1");
  const common = {
    status: response.status,
    headers: responseHeaders,
    credential_id: credential.credential_id,
  };
  if (verb === "DELETE") return { ...common, body: null };
  if (verb === "HEAD")
    return { ...common, body: { key, size: Number(responseHeaders["content-length"] ?? 0), etag } };
  if (verb === "PUT")
    return {
      ...common,
      body: {
        key,
        etag,
        version_id: responseHeaders["x-amz-version-id"] ?? null,
        multipart: false,
      },
    };
  const contentType = responseHeaders["content-type"]?.toLowerCase() ?? "";
  const text = contentType.startsWith("text/") || /json|xml|yaml|csv/.test(contentType);
  return { ...common, body: text ? buffer.toString("utf8") : buffer };
}
