// S3 driver. Uses @bradenmacdonald/s3-lite-client to talk to any
// S3-compatible store (AWS S3, MinIO, R2, etc.). The driver speaks the
// same {status, headers, body} shape the HTTP driver uses so JSONata
// expressions and response selectors keep working unchanged.
//
// Connector config: { region, endpoint?, bucket, force_path_style? }
// Credentials carry { access_key_id, secret_access_key, session_token? }
// (sourced from the credential layer; for header-mode creds the keys
// land on `headers.x-access-key-id` / `headers.x-secret-access-key`).
//
// `request` step contract:
//   method: "GET" | "PUT" | "HEAD" | "LIST" | "DELETE"
//   path:   "/<key>"     (LIST treats path as a prefix, "/" means root)
//   body:   string | Buffer | Uint8Array (PUT only)

import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { ConnectorView } from "../types.ts";

export interface S3ConnectorConfig {
  region: string;
  endpoint?: string;
  bucket: string;
  force_path_style?: boolean;
}

export interface S3Credentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface S3Response {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer | unknown;
  /** Credential row id used for this call, or null when none. Surfaces
   *  through to the egress audit (`CREDENTIAL_ACCESSED`). */
  credential_id: string | null;
}

export type S3Method = "GET" | "PUT" | "HEAD" | "LIST" | "DELETE";

function parseConfig(connector: ConnectorView): S3ConnectorConfig {
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
  const region = typeof cfg.region === "string" ? cfg.region : "us-east-1";
  const bucket = typeof cfg.bucket === "string" ? cfg.bucket : "";
  if (!bucket) throw new Error(`s3 connector ${connector.id} missing config.bucket`);
  const out: S3ConnectorConfig = { region, bucket };
  if (typeof cfg.endpoint === "string" && cfg.endpoint.length > 0) out.endpoint = cfg.endpoint;
  if (typeof cfg.force_path_style === "boolean") out.force_path_style = cfg.force_path_style;
  return out;
}

/**
 * Pull S3 credentials from the credentials store. The connector layer
 * stores them as a `header` mode credential whose headers contain the
 * canonical `x-access-key-id`/`x-secret-access-key`/`x-session-token`
 * keys. For `auth_type=none` (anonymous / public buckets), inline config
 * keys are still accepted so test fixtures keep working.
 *
 * When `auth_type !== "none"` the inline config branch is bypassed — credentials
 * must come from the encrypted credential row to close the draft-auth shortcut.
 */
async function resolveS3Credentials(
  db: Db,
  tenant_id: string,
  connector: ConnectorView,
): Promise<{ creds: S3Credentials | null; credential_id: string | null }> {
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
  if (connector.auth_type === "none") {
    // Anonymous / public-bucket path: accept inline keys on config only when
    // auth_type is explicitly none. This covers test fixtures and public S3 buckets.
    if (
      typeof cfg.access_key_id === "string" &&
      typeof cfg.secret_access_key === "string" &&
      cfg.access_key_id.length > 0
    ) {
      const out: S3Credentials = {
        access_key_id: cfg.access_key_id,
        secret_access_key: cfg.secret_access_key,
      };
      if (typeof cfg.session_token === "string") out.session_token = cfg.session_token;
      return { creds: out, credential_id: null };
    }
    return { creds: null, credential_id: null };
  }
  // auth_type !== "none": credentials must come from the encrypted store.
  const row = await getCredentialForConnector(tenant_id, connector.id, connector.environment, db);
  if (!row) return { creds: null, credential_id: null };
  const v = row.value;
  if (v.mode !== "header") return { creds: null, credential_id: row.row.id };
  const headers = v.headers;
  const id = headers["x-access-key-id"] ?? headers["X-Access-Key-Id"] ?? "";
  const secret = headers["x-secret-access-key"] ?? headers["X-Secret-Access-Key"] ?? "";
  if (!id || !secret) return { creds: null, credential_id: row.row.id };
  const out: S3Credentials = { access_key_id: id, secret_access_key: secret };
  const sess = headers["x-session-token"] ?? headers["X-Session-Token"];
  if (sess) out.session_token = sess;
  return { creds: out, credential_id: row.row.id };
}

/**
 * Build an S3 client for a connector. Tests can pass a pre-resolved
 * credential bag instead of going through the credential store.
 */
export function buildS3Client(p: {
  connector: ConnectorView;
  credentials?: S3Credentials | null;
}): S3Client {
  const cfg = parseConfig(p.connector);
  const opts: Record<string, unknown> = {
    region: cfg.region,
    endPoint: cfg.endpoint ?? `s3.${cfg.region}.amazonaws.com`,
    bucket: cfg.bucket,
    pathStyle: cfg.force_path_style ?? true,
  };
  if (p.credentials) {
    opts.accessKey = p.credentials.access_key_id;
    opts.secretKey = p.credentials.secret_access_key;
    if (p.credentials.session_token) opts.sessionToken = p.credentials.session_token;
  }
  return new S3Client(opts as ConstructorParameters<typeof S3Client>[0]);
}

function trimKey(path: string): string {
  let k = path;
  if (k.startsWith("/")) k = k.slice(1);
  return k;
}

function headersFromResponse(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * Execute one S3 operation. Translates the connector-level method into
 * the right s3-lite-client call and normalises the result back into the
 * driver-shared `{status, headers, body}` envelope.
 */
export async function executeS3Request(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: S3Method;
  path: string;
  body?: string | Uint8Array | Buffer | AsyncIterable<Uint8Array> | null;
  /** Content-Type for PUT. Forwarded to the s3-lite-client putObject. */
  contentType?: string;
  /** Object metadata for PUT. Each entry rides as `x-amz-meta-<key>`. */
  metadata?: Record<string, string>;
  /** LIST cap. Defaults to 1000; capped to 10 000 to keep scope bounded. */
  maxKeys?: number;
  /** When true, walk continuation tokens until `maxKeys` is reached
   *  or the bucket is exhausted. When false (default), the driver
   *  returns at most one batch (still bounded by `maxKeys`). */
  paginate?: boolean;
  /** Override the multipart-upload threshold in MiB. The driver
   *  switches to multipart upload when the body exceeds this size.
   *  Defaults to 8 (s3-lite-client's default). When `multipart: false`
   *  the threshold is forced to a value larger than the body so a
   *  single PUT is used regardless. */
  multipart?: boolean;
  multipartThresholdMb?: number;
  /** RFC 7233 byte-range expression for partial GETs. Forwarded as a
   *  Range request header. */
  range?: string;
  /** When set, the operation is *not* executed; the driver returns a
   *  presigned URL that grants temporary access to the operation
   *  caller. Supported on GET / PUT. */
  presignExpiresIn?: number;
}): Promise<S3Response> {
  const { creds: credentials, credential_id } = await resolveS3Credentials(
    p.db,
    p.tenant_id,
    p.connector,
  );
  const client = buildS3Client({ connector: p.connector, credentials });
  const key = trimKey(p.path);
  const method = p.method.toUpperCase() as S3Method;
  logger.debug({
    module: "connector",
    action: "s3.request",
    connector_id: p.connector.id,
    method,
    key,
    has_credential: credentials !== null,
  });
  switch (method) {
    case "GET": {
      // Presigned URL path — operator wants delegated read access.
      if (p.presignExpiresIn !== undefined) {
        const url = await client.getPresignedUrl("GET", key, {
          expirySeconds: p.presignExpiresIn,
        });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            url,
            method: "GET",
            expires_at: new Date(Date.now() + p.presignExpiresIn * 1000).toISOString(),
          },
          credential_id,
        };
      }
      // s3-lite-client's getObject doesn't accept custom headers, so
      // when a range is requested we fall through to its signed-URL
      // helper + a direct fetch with the Range header. This keeps
      // partial-GET semantics without forking the client.
      let res: Response;
      if (p.range) {
        const url = await client.getPresignedUrl("GET", key, { expirySeconds: 60 });
        res = await fetch(url, { headers: { range: p.range } });
      } else {
        res = await client.getObject(key);
      }
      // Surface raw bytes when the caller wants them. `arrayBuffer()`
      // is preferred over `.text()` because it preserves binary
      // payloads losslessly; the request-step driver decides how to
      // hand them off (text / base64 / bytes / auto).
      const buffer = Buffer.from(await res.arrayBuffer());
      const headers = headersFromResponse(res);
      // For text-y content types, also expose the decoded string so a
      // caller without `parse_as` set still sees readable output (the
      // historical behaviour). Binary content stays as Buffer.
      const ct = (headers["content-type"] ?? "").toLowerCase();
      const isText =
        ct.startsWith("text/") ||
        ct.includes("json") ||
        ct.includes("xml") ||
        ct.includes("yaml") ||
        ct.includes("csv");
      return {
        status: res.status,
        headers,
        body: isText ? buffer.toString("utf8") : buffer,
        credential_id,
      };
    }
    case "PUT": {
      if (p.body === undefined || p.body === null) {
        throw new Error("s3 PUT requires a body");
      }
      // Presigned URL path on PUT — caller uploads directly to S3.
      if (p.presignExpiresIn !== undefined) {
        const url = await client.getPresignedUrl("PUT", key, {
          expirySeconds: p.presignExpiresIn,
        });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            url,
            method: "PUT",
            expires_at: new Date(Date.now() + p.presignExpiresIn * 1000).toISOString(),
          },
          credential_id,
        };
      }
      // Buffer AsyncIterable bodies (from ResolvedFile.openRead) up to a
      // reasonable cap. s3-lite-client's putObject does not accept streams
      // natively; we collect chunks into a Uint8Array before passing them.
      // Files larger than 50 MB should be spooled to tmpfile by the
      // step-runner before reaching here, keeping per-call memory bounded.
      let data: string | Uint8Array;
      if (
        p.body !== null &&
        typeof p.body === "object" &&
        Symbol.asyncIterator in (p.body as object)
      ) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of p.body as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        data = merged;
      } else {
        const syncBody = p.body as string | Uint8Array | Buffer;
        data =
          typeof syncBody === "string"
            ? syncBody
            : syncBody instanceof Uint8Array
              ? syncBody
              : new Uint8Array(syncBody);
      }
      const putOpts: Record<string, unknown> = {};
      if (p.contentType) putOpts.metadata = { "Content-Type": p.contentType };
      if (p.metadata) {
        const metaHeaders: Record<string, string> = {};
        if (p.contentType) metaHeaders["Content-Type"] = p.contentType;
        for (const [k, v] of Object.entries(p.metadata)) {
          // S3 prefixes user-defined metadata with `x-amz-meta-` on the
          // wire. The s3-lite-client passes `metadata` straight into
          // the headers, so we apply the prefix ourselves to avoid
          // collisions with reserved Content-* headers.
          metaHeaders[`x-amz-meta-${k.toLowerCase()}`] = v;
        }
        putOpts.metadata = metaHeaders;
      }
      // Multipart configuration. The s3-lite-client switches on size by
      // default; explicit `multipart: false` forces a single PUT by
      // raising the threshold above the body size, and an explicit
      // threshold MiB overrides the default 8 MiB.
      const dataSize =
        typeof data === "string"
          ? Buffer.byteLength(data, "utf8")
          : (data as Uint8Array).byteLength;
      const thresholdMb = p.multipartThresholdMb ?? 0;
      const partSize =
        p.multipart === false
          ? Math.max(dataSize + 1, 8 * 1024 * 1024)
          : thresholdMb > 0
            ? thresholdMb * 1024 * 1024
            : undefined;
      if (partSize !== undefined) putOpts.partSize = partSize;
      const info = await client.putObject(
        key,
        data,
        Object.keys(putOpts).length > 0 ? (putOpts as never) : undefined,
      );
      return {
        status: 200,
        headers: {
          etag: info.etag,
          "x-amz-version-id": info.versionId ?? "",
          ...(p.contentType ? { "content-type": p.contentType } : {}),
        },
        body: {
          etag: info.etag,
          version_id: info.versionId,
          key,
          multipart: typeof partSize === "number" && partSize <= dataSize,
        },
        credential_id,
      };
    }
    case "HEAD": {
      const exists = await client.exists(key);
      if (!exists) {
        return { status: 404, headers: {}, body: null, credential_id };
      }
      const stat = await client.statObject(key);
      return {
        status: 200,
        headers: {
          "content-length": String(stat.size),
          etag: stat.etag,
        },
        body: { key: stat.key, size: stat.size, etag: stat.etag },
        credential_id,
      };
    }
    case "LIST": {
      const prefix = key.length > 0 ? key : "";
      const cap = Math.min(p.maxKeys ?? 1000, 10_000);
      const items: Array<{ key: string; size: number; etag: string; last_modified: string }> = [];
      // The s3-lite-client iterator already follows continuation
      // tokens internally; we just decide when to stop walking. With
      // `paginate: true` the iterator runs until either the bucket is
      // exhausted or `cap` is hit. Without it, a single LIST batch is
      // collected so callers can opt-in to the heavier traversal.
      const stopAt = p.paginate === true ? cap : Math.min(cap, 1000);
      for await (const obj of client.listObjects({ prefix })) {
        if (obj.type !== "Object") continue;
        if (items.length >= stopAt) break;
        items.push({
          key: obj.key,
          size: obj.size,
          etag: obj.etag,
          last_modified: obj.lastModified.toISOString(),
        });
      }
      return {
        status: 200,
        headers: {},
        body: {
          items,
          count: items.length,
          truncated: items.length >= stopAt,
          paginated: p.paginate === true,
        },
        credential_id,
      };
    }
    case "DELETE": {
      await client.deleteObject(key);
      return { status: 204, headers: {}, body: null, credential_id };
    }
    default: {
      throw new Error(`s3 driver: unsupported method ${method}`);
    }
  }
}

/**
 * Health probe: run the same LIST flow that the request executor uses.
 * This keeps probe behavior aligned with real authoring-time validation
 * and works against S3-compatible endpoints that do not implement the
 * lighter `bucketExists` shortcut.
 */
export async function probeS3Connector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
}): Promise<{ ok: boolean; latency_ms: number; status?: number; detail?: string }> {
  const start = Date.now();
  try {
    // Guard: auth-required connectors must have a persisted credential row.
    if (p.connector.auth_type !== "none") {
      const row = await getCredentialForConnector(
        p.tenant_id,
        p.connector.id,
        p.connector.environment,
        p.db,
      );
      if (!row) {
        return {
          ok: false,
          latency_ms: 0,
          detail: "credential_required",
        };
      }
    }

    const res = await executeS3Request({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      method: "LIST",
      path: "/",
    });
    const latency_ms = Date.now() - start;
    if (res.status < 200 || res.status >= 300) {
      logger.warn({
        module: "connector",
        action: "s3.probe.failed",
        connector_id: p.connector.id,
        latency_ms,
        status: res.status,
      });
      return {
        ok: false,
        latency_ms,
        status: res.status,
        detail: `LIST returned HTTP ${res.status}`,
      };
    }
    logger.debug({
      module: "connector",
      action: "s3.probe.completed",
      connector_id: p.connector.id,
      ok: true,
      latency_ms,
      status: res.status,
    });
    return { ok: true, latency_ms, status: res.status };
  } catch (err) {
    const latency_ms = Date.now() - start;
    logger.warn({
      module: "connector",
      action: "s3.probe.failed",
      connector_id: p.connector.id,
      latency_ms,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, latency_ms, detail: err instanceof Error ? err.message : String(err) };
  }
}
