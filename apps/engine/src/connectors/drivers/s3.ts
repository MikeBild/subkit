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
 * keys, OR they can be carried directly on `connector.config.access_key_id`
 * for unauthenticated test buckets.
 */
async function resolveS3Credentials(
  db: Db,
  tenant_id: string,
  connector: ConnectorView,
): Promise<S3Credentials | null> {
  // Inline config path — for "none" auth, allow the keys on config.
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
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
    return out;
  }
  if (connector.auth_type === "none") return null;
  const row = await getCredentialForConnector(tenant_id, connector.id, connector.environment, db);
  if (!row) return null;
  const v = row.value;
  if (v.mode !== "header") return null;
  const headers = v.headers;
  const id = headers["x-access-key-id"] ?? headers["X-Access-Key-Id"] ?? "";
  const secret = headers["x-secret-access-key"] ?? headers["X-Secret-Access-Key"] ?? "";
  if (!id || !secret) return null;
  const out: S3Credentials = { access_key_id: id, secret_access_key: secret };
  const sess = headers["x-session-token"] ?? headers["X-Session-Token"];
  if (sess) out.session_token = sess;
  return out;
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
  body?: string | Uint8Array | Buffer | null;
}): Promise<S3Response> {
  const credentials = await resolveS3Credentials(p.db, p.tenant_id, p.connector);
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
      const res = await client.getObject(key);
      const text = await res.text();
      return { status: res.status, headers: headersFromResponse(res), body: text };
    }
    case "PUT": {
      if (p.body === undefined || p.body === null) {
        throw new Error("s3 PUT requires a body");
      }
      const data =
        typeof p.body === "string"
          ? p.body
          : p.body instanceof Uint8Array
            ? p.body
            : new Uint8Array(p.body as Buffer);
      const info = await client.putObject(key, data);
      return {
        status: 200,
        headers: { etag: info.etag, "x-amz-version-id": info.versionId ?? "" },
        body: { etag: info.etag, version_id: info.versionId },
      };
    }
    case "HEAD": {
      const exists = await client.exists(key);
      if (!exists) {
        return { status: 404, headers: {}, body: null };
      }
      const stat = await client.statObject(key);
      return {
        status: 200,
        headers: {
          "content-length": String(stat.size),
          etag: stat.etag,
        },
        body: { key: stat.key, size: stat.size, etag: stat.etag },
      };
    }
    case "LIST": {
      const prefix = key.length > 0 ? key : "";
      const items: Array<{ key: string; size: number; etag: string; last_modified: string }> = [];
      for await (const obj of client.listObjects({ prefix })) {
        if (obj.type !== "Object") continue;
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
        body: { items, count: items.length },
      };
    }
    case "DELETE": {
      await client.deleteObject(key);
      return { status: 204, headers: {}, body: null };
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
