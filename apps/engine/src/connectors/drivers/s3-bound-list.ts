// Controlled S3 listing: every page crosses the same authority and egress gates.
import type { S3Client } from "@bradenmacdonald/s3-lite-client";
import { parseXmlBody } from "../../utils/xml-parser.ts";
import { assertEgressAllowedResolved } from "../egress-guard.ts";
import { signSigV4Request } from "./aws-sigv4.ts";
import { getDriverFetch } from "./fetch-seam.ts";
import {
  checkAuthorityRedirect,
  type ResolvedConnectorCredential,
  readBodyBytesCapped,
  resolveMaxResponseBytes,
} from "./http.ts";
import type { executeS3Request, S3Credentials, S3Response } from "./s3.ts";

type Item = { key: string; size: number; etag: string; last_modified: string };
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function invalid(): never {
  throw new Error("S3 listing returned an invalid or out-of-scope page");
}

export async function executeBoundS3List(p: {
  client: S3Client;
  params: Parameters<typeof executeS3Request>[0];
  credentials: S3Credentials | null;
  credential: Pick<
    ResolvedConnectorCredential,
    "credential_id" | "credential_revision" | "connection_authority"
  >;
}): Promise<S3Response> {
  const { client, params, credential, credentials } = p;
  if (
    params.body != null ||
    params.presignExpiresIn !== undefined ||
    params.multipart !== undefined ||
    params.metadata ||
    params.range ||
    params.contentType
  )
    throw Object.assign(new Error("Unsupported bounded S3 listing options"), {
      code: "authority_unknown",
    });
  const requested = params.maxKeys ?? 1000;
  if (!Number.isInteger(requested) || requested < 1)
    throw new Error("S3 listing requires a positive key limit");
  const cap = Math.min(requested, params.paginate === true ? 10_000 : 1000);
  const prefix = params.path.replace(/^\//, "");
  const host = client.pathStyle ? client.host : `${client.defaultBucket}.${client.host}`;
  const path = client.pathStyle ? `${client.pathPrefix ?? ""}/${client.defaultBucket}/` : "/";
  const target = new URL(
    `${client.protocol}//${host}${path.split("/").map(encodeURIComponent).join("/")}`,
  );
  const signal = params.signal
    ? AbortSignal.any([params.signal, AbortSignal.timeout(params.timeout_ms ?? 30_000)])
    : AbortSignal.timeout(params.timeout_ms ?? 30_000);
  const items: Item[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  let truncated = false;
  for (let page = 0; page < 100 && items.length < cap; page += 1) {
    signal.throwIfAborted();
    const url = new URL(target);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", String(Math.min(1000, cap - items.length)));
    if (token) url.searchParams.set("continuation-token", token);
    await assertEgressAllowedResolved(url, { tenant_id: params.tenant_id });
    const headers: Record<string, string> = {};
    if (credentials)
      signSigV4Request({
        method: "GET",
        url,
        headers,
        region: client.region,
        service: "s3",
        credential: credentials,
      });
    await params.before_dispatch?.(credential, {
      method: "GET",
      url: url.href,
      headers: {},
      body: null,
    });
    signal.throwIfAborted();
    const response = await getDriverFetch()(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
    await checkAuthorityRedirect(response, { redirect: "manual" });
    const buffer = await readBodyBytesCapped(
      response,
      resolveMaxResponseBytes(params.tenant_id),
      "bound S3 listing",
      signal,
    );
    if (!response.ok) throw new Error(`S3 listing failed with status ${response.status}`);
    const root = record(record(parseXmlBody(buffer.toString("utf8")))?.ListBucketResult);
    if (!root || !["true", "false", true, false].includes(root.IsTruncated as string | boolean))
      invalid();
    const entries =
      root.Contents === undefined
        ? []
        : Array.isArray(root.Contents)
          ? root.Contents
          : [root.Contents];
    if (entries.length > Math.min(1000, cap - items.length)) invalid();
    for (const raw of entries) {
      const entry = record(raw);
      const key = entry?.Key;
      const size = Number(entry?.Size);
      const modified = entry?.LastModified;
      if (
        typeof key !== "string" ||
        !key.startsWith(prefix) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof modified !== "string" ||
        !Number.isFinite(Date.parse(modified)) ||
        typeof entry?.ETag !== "string"
      )
        invalid();
      items.push({
        key,
        size,
        etag: entry.ETag.replace(/^"(.*)"$/, "$1"),
        last_modified: new Date(modified).toISOString(),
      });
    }
    truncated = root.IsTruncated === true || root.IsTruncated === "true";
    if (!truncated || params.paginate !== true || items.length >= cap) break;
    const next = root.NextContinuationToken;
    if (typeof next !== "string" || !next || next.length > 16_384 || tokens.has(next)) invalid();
    tokens.add(next);
    token = next;
  }
  return {
    status: 200,
    headers: {},
    body: { items, count: items.length, truncated, paginated: params.paginate === true },
    credential_id: credential.credential_id,
  };
}
