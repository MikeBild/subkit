import { S3Client } from "@bradenmacdonald/s3-lite-client";
import type { CredentialUseSnapshot } from "../../credentials/index.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db, Executor } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import {
  assertEgressAllowedResolved,
  resolveEgressGuardMode,
  resolveTenantEgressContext,
} from "../egress-guard.ts";
import type { ConnectorView } from "../types.ts";
import { getDriverFetch } from "./fetch-seam.ts";
import type {
  HttpDispatchObservation,
  RequestDispatchPolicy,
  ResolvedConnectorCredential,
} from "./http.ts";
import type { DriverProbeResult } from "./index.ts";
import { classifyS3ProbeError } from "./probe-classify.ts";
import { executeBoundS3Request } from "./s3-bound-dispatch.ts";
import { executeBoundS3List } from "./s3-bound-list.ts";
import { makeGuardedS3Request } from "./s3-guarded-request.ts";

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
  credential_id: string | null;
}

export type S3Method = "GET" | "PUT" | "HEAD" | "LIST" | "DELETE";

export class S3CredentialError extends Error {
  constructor(
    message: string,
    public readonly error_code:
      | "credential_missing"
      | "credential_invalid"
      | "credential_mode_unsupported_for_s3",
  ) {
    super(message);
    this.name = "S3CredentialError";
  }
}

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

async function resolveS3Credentials(
  db: Db,
  tenant_id: string,
  connector: ConnectorView,
  override?: DecryptedCredential | null,
): Promise<{
  creds: S3Credentials | null;
  credential_id: string | null;
  credential_revision: number | null;
  credential_snapshot?: CredentialUseSnapshot;
}> {
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
  if (connector.auth_type === "none") {
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
      return { creds: out, credential_id: null, credential_revision: null };
    }
    return { creds: null, credential_id: null, credential_revision: null };
  }
  const row =
    override !== undefined
      ? override && {
          value: override,
          row: {
            id: null as string | null,
            authority_revision: null as number | null,
            credential_generation: null,
            verified_identity: null,
          },
        }
      : await getCredentialForConnector(tenant_id, connector.id, connector.environment, db);
  if (!row) {
    throw new S3CredentialError(
      `s3 connector ${connector.slug} (auth_type ${connector.auth_type}) has no stored credential for environment ${connector.environment}`,
      "credential_missing",
    );
  }
  const credential_snapshot: CredentialUseSnapshot = {
    connector_id: connector.id,
    environment: connector.environment,
    credential_id: row.row.id,
    credential_generation: row.row.credential_generation,
    connection_id: null,
    access_token_version: null,
    identity: row.row.verified_identity,
  };
  const v = row.value;
  if (v.mode === "aws_sigv4") {
    const out: S3Credentials = {
      access_key_id: v.access_key_id,
      secret_access_key: v.secret_access_key,
    };
    if (v.session_token) out.session_token = v.session_token;
    return {
      creds: out,
      credential_id: row.row.id,
      credential_revision: row.row.authority_revision,
      credential_snapshot,
    };
  }
  if (v.mode !== "header") {
    throw new S3CredentialError(
      `s3 driver cannot sign with a "${v.mode}" credential — store the keys as aws_sigv4, or as header mode with x-access-key-id / x-secret-access-key`,
      "credential_mode_unsupported_for_s3",
    );
  }
  const headers = v.headers;
  const id = headers["x-access-key-id"] ?? headers["X-Access-Key-Id"] ?? "";
  const secret = headers["x-secret-access-key"] ?? headers["X-Secret-Access-Key"] ?? "";
  if (!id || !secret) {
    throw new S3CredentialError(
      "header-mode s3 credential is missing x-access-key-id / x-secret-access-key",
      "credential_invalid",
    );
  }
  const out: S3Credentials = { access_key_id: id, secret_access_key: secret };
  const sess = headers["x-session-token"] ?? headers["X-Session-Token"];
  if (sess) out.session_token = sess;
  return {
    creds: out,
    credential_id: row.row.id,
    credential_revision: row.row.authority_revision,
    credential_snapshot,
  };
}

class ObservedS3Client extends S3Client {
  #credentials: S3Credentials | null;
  constructor(
    options: ConstructorParameters<typeof S3Client>[0],
    private readonly onCredentialUse?: () => Promise<void>,
    private readonly tenantId?: string,
    credentials: S3Credentials | null = null,
    private readonly exec?: Executor,
  ) {
    super(options);
    this.#credentials = credentials;
  }
  override async makeRequest(options: Parameters<S3Client["makeRequest"]>[0]): Promise<Response> {
    const bucket = options.bucketName ?? this.defaultBucket;
    const host = this.pathStyle ? this.host : `${bucket}.${this.host}`;
    const context = await resolveTenantEgressContext({
      ...(this.tenantId === undefined ? {} : { tenant_id: this.tenantId }),
      ...(this.exec ? { exec: this.exec } : {}),
    });
    if (resolveEgressGuardMode(context) === "strict") {
      await assertEgressAllowedResolved(`${this.protocol}//${host}/`, context);
      return makeGuardedS3Request({
        client: this,
        bucket: this.getBucketName(options),
        options,
        credentials: this.#credentials,
        context,
        onCredentialUse: this.onCredentialUse,
      });
    }
    await this.onCredentialUse?.();
    return super.makeRequest(options);
  }
}

export function buildS3Client(p: {
  exec?: Executor;
  on_credential_use?: () => Promise<void>;
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
  return new ObservedS3Client(
    opts as ConstructorParameters<typeof S3Client>[0],
    p.on_credential_use,
    p.connector.tenant_id,
    p.credentials ?? null,
    p.exec,
  );
}

export function assertRemovableObject(key: string, body: unknown): void {
  if (body !== undefined && body !== null)
    throw new Error(
      "s3 DELETE does not accept a body — remove one object per request (for_each with s3.key)",
    );
  if (key === "" || key.endsWith("/"))
    throw new Error(`s3 DELETE key "${key}" is a folder prefix, not an object key`);
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

export async function executeS3Request(p: {
  on_credential_use?: (snapshot: CredentialUseSnapshot) => Promise<void>;
  before_dispatch?: (
    credential: Pick<
      ResolvedConnectorCredential,
      "credential_id" | "credential_revision" | "connection_authority" | "credential_snapshot"
    >,
    request?: HttpDispatchObservation,
  ) => Promise<RequestDispatchPolicy | undefined>;
  signal?: AbortSignal;
  timeout_ms?: number;
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: S3Method;
  path: string;
  body?: string | Uint8Array | Buffer | AsyncIterable<Uint8Array> | null;
  contentType?: string;
  metadata?: Record<string, string>;
  maxKeys?: number;
  paginate?: boolean;
  multipart?: boolean;
  multipartThresholdMb?: number;
  range?: string;
  presignExpiresIn?: number;
  credential_override?: DecryptedCredential | null;
}): Promise<S3Response> {
  const {
    creds: credentials,
    credential_id,
    credential_revision,
    credential_snapshot,
  } = await resolveS3Credentials(p.db, p.tenant_id, p.connector, p.credential_override);
  const snapshot = credential_snapshot ?? {
    connector_id: p.connector.id,
    environment: p.connector.environment,
    credential_id,
    credential_generation: null,
    connection_id: null,
    access_token_version: null,
    identity: null,
  };
  const client = buildS3Client({
    exec: p.db,
    connector: p.connector,
    credentials,
    ...(!p.before_dispatch && p.on_credential_use
      ? { on_credential_use: () => p.on_credential_use?.(snapshot) ?? Promise.resolve() }
      : {}),
  });
  if (p.before_dispatch && p.method === "LIST")
    return executeBoundS3List({
      client,
      params: p,
      credentials,
      credential: {
        credential_id,
        credential_revision,
        connection_authority: null,
        ...(credential_snapshot ? { credential_snapshot } : {}),
      },
    });
  if (p.before_dispatch)
    return executeBoundS3Request({
      client,
      params: p,
      credential: {
        credential_id,
        credential_revision,
        connection_authority: null,
        ...(credential_snapshot ? { credential_snapshot } : {}),
      },
    });
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
  return await instrument({
    module: "connector",
    action: "driver.s3.request",
    level: "debug",
    thresholdMs: 1000,
    fields: { connector_id: p.connector.id, op: method, key },
    fn: () => executeS3Operation({ client, method, key, credential_id, snapshot, p }),
  });
}

async function executeS3Operation(ctx: {
  client: S3Client;
  method: S3Method;
  key: string;
  credential_id: string | null;
  snapshot: CredentialUseSnapshot;
  p: Parameters<typeof executeS3Request>[0];
}): Promise<S3Response> {
  const { client, method, key, credential_id, snapshot, p } = ctx;
  switch (method) {
    case "GET": {
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
      let res: Response;
      if (p.range) {
        const url = await client.getPresignedUrl("GET", key, { expirySeconds: 60 });
        await p.on_credential_use?.(snapshot);
        res = await getDriverFetch()(url, { headers: { range: p.range } });
      } else {
        res = await client.getObject(key);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const headers = headersFromResponse(res);
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
      let data: string | Uint8Array | ReadableStream<Uint8Array>;
      let streamedBody = false;
      if (
        p.body !== null &&
        typeof p.body === "object" &&
        Symbol.asyncIterator in (p.body as object)
      ) {
        const iterator = (p.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
        data = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { value, done } = await iterator.next();
              if (done) {
                controller.close();
                return;
              }
              if (value) controller.enqueue(value);
            } catch (err) {
              controller.error(err);
            }
          },
          async cancel(reason) {
            if (typeof iterator.return === "function") {
              try {
                await iterator.return(reason);
              } catch {}
            }
          },
        });
        streamedBody = true;
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
          metaHeaders[`x-amz-meta-${k.toLowerCase()}`] = v;
        }
        putOpts.metadata = metaHeaders;
      }
      const dataSize: number | null =
        typeof data === "string"
          ? Buffer.byteLength(data, "utf8")
          : data instanceof Uint8Array
            ? data.byteLength
            : null;
      if (streamedBody && p.multipartThresholdMb === undefined) {
        logger.warn({
          module: "connector",
          action: "s3.put.unbounded_stream",
          msg: "s3 PUT streaming AsyncIterable without multipartThresholdMb hint — using client default part size",
          key,
        });
      }
      const thresholdMb = p.multipartThresholdMb ?? 0;
      const partSize =
        p.multipart === false && dataSize !== null
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
          multipart:
            dataSize === null ? null : typeof partSize === "number" && partSize <= dataSize,
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
      assertRemovableObject(key, p.body);
      await client.deleteObject(key);
      return { status: 204, headers: {}, body: null, credential_id };
    }
    default: {
      throw new Error(`s3 driver: unsupported method ${method}`);
    }
  }
}

export async function probeS3Connector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
}): Promise<DriverProbeResult> {
  const start = Date.now();
  try {
    if (p.connector.auth_type !== "none") {
      const row =
        p.credential_override !== undefined
          ? p.credential_override && { value: p.credential_override }
          : await getCredentialForConnector(
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
          error_code: "credential_missing",
        };
      }
    }

    const res = await executeS3Request({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      method: "LIST",
      path: "/",
      ...(p.credential_override !== undefined
        ? { credential_override: p.credential_override }
        : {}),
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
        error_code: classifyS3ProbeError({ statusCode: res.status }),
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
      ...errorFields(err),
    });
    return {
      ok: false,
      latency_ms,
      detail: err instanceof Error ? err.message : String(err),
      error_code: classifyS3ProbeError(err),
    };
  }
}
