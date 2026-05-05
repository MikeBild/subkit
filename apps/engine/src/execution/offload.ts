// Large-payload offload. When a serialized step result exceeds the
// threshold (10 KB), the engine writes it to either:
//
//   (a) S3-compatible object storage when S3_OFFLOAD_BUCKET is set
//       (plus S3_OFFLOAD_REGION / S3_OFFLOAD_ENDPOINT /
//       S3_OFFLOAD_ACCESS_KEY / S3_OFFLOAD_SECRET_KEY). The returned
//       `storage_uri` is `s3://<bucket>/<key>`.
//
//   (b) Otherwise, the `execution_fixtures` table with `kind = 'offload'`.
//       The returned `storage_uri` is `fixture://<uuid>`.
//
// A 512-byte text preview is always stored inline so operators can see
// at a glance what the payload looked like without resolving it.

import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db } from "../db/client.ts";
import { executionFixtures } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { STEP_RESULT_DB_BYTES, STEP_RESULT_PREVIEW_BYTES } from "./timeouts.ts";

export interface OffloadResult {
  // 'fixture://<uuid>' or 's3://<bucket>/<key>' or null if inline.
  storage_uri: string | null;
  preview: string | null; // truncated string preview if offloaded
  size_bytes: number;
}

export function previewOf(value: unknown): string {
  const s = JSON.stringify(value) ?? "null";
  return s.length > STEP_RESULT_PREVIEW_BYTES ? s.slice(0, STEP_RESULT_PREVIEW_BYTES) : s;
}

export interface MaybeOffloadParams {
  tenant_id: string;
  execution_id: string;
  step_id?: string | null;
  result: unknown;
}

interface S3OffloadConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKey: string;
  secretKey: string;
  keyPrefix: string;
}

function s3OffloadConfig(): S3OffloadConfig | null {
  // Prefer the runtime config; fall back to historical env vars when
  // the loader is uninitialised (unit tests + standalone scripts).
  let off: {
    bucket: string;
    region: string;
    access_key: string;
    secret_key: string;
    endpoint: string;
    key_prefix: string;
  } | null = null;
  let bedrockRegion = "";
  let bedrockAccess = "";
  let bedrockSecret = "";
  try {
    const cfg = (
      require("../config/loader.ts") as typeof import("../config/loader.ts")
    ).getConfig();
    off = cfg.storage.offload;
    bedrockRegion = cfg.llm.providers.bedrock.region;
    bedrockAccess = cfg.llm.providers.bedrock.access_key_id;
    bedrockSecret = cfg.llm.providers.bedrock.secret_access_key;
  } catch {
    /* loader not initialised — fall through to env */
  }
  const bucket = off?.bucket || process.env.S3_OFFLOAD_BUCKET || "";
  if (!bucket) return null;
  const accessKey =
    off?.access_key ||
    process.env.S3_OFFLOAD_ACCESS_KEY ||
    bedrockAccess ||
    process.env.AWS_ACCESS_KEY_ID;
  const secretKey =
    off?.secret_key ||
    process.env.S3_OFFLOAD_SECRET_KEY ||
    bedrockSecret ||
    process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) {
    logger.warn({
      module: "execution",
      action: "offload.s3_misconfigured",
      msg: "storage.offload.bucket set but access keys missing — falling back to fixture table",
    });
    return null;
  }
  const cfg: S3OffloadConfig = {
    bucket,
    region:
      off?.region ||
      process.env.S3_OFFLOAD_REGION ||
      bedrockRegion ||
      process.env.AWS_REGION ||
      "us-east-1",
    accessKey,
    secretKey,
    keyPrefix: off?.key_prefix || process.env.S3_OFFLOAD_KEY_PREFIX || "offload",
  };
  const endpoint = off?.endpoint || process.env.S3_OFFLOAD_ENDPOINT;
  if (endpoint) cfg.endpoint = endpoint;
  return cfg;
}

async function writeToS3(
  cfg: S3OffloadConfig,
  params: MaybeOffloadParams,
  serialized: string,
): Promise<string> {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const key = `${cfg.keyPrefix}/${params.tenant_id}/${params.execution_id}/${id}.json`;
  const client = new S3Client({
    endPoint: cfg.endpoint ?? `s3.${cfg.region}.amazonaws.com`,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    pathStyle: Boolean(cfg.endpoint),
  });
  await client.putObject(key, serialized);
  return `s3://${cfg.bucket}/${key}`;
}

export async function maybeOffload(db: Db, params: MaybeOffloadParams): Promise<OffloadResult> {
  const serialized = JSON.stringify(params.result) ?? "null";
  const size = Buffer.byteLength(serialized, "utf8");
  if (size <= STEP_RESULT_DB_BYTES) {
    return { storage_uri: null, preview: null, size_bytes: size };
  }

  // Prefer S3 when configured. On any S3 error we fall back to the
  // fixture table so the execution pipeline still completes — an
  // offload failure should not fail a whole run.
  const s3cfg = s3OffloadConfig();
  if (s3cfg) {
    try {
      const uri = await writeToS3(s3cfg, params, serialized);
      return {
        storage_uri: uri,
        preview: serialized.slice(0, STEP_RESULT_PREVIEW_BYTES),
        size_bytes: size,
      };
    } catch (err) {
      logger.warn({
        module: "execution",
        action: "offload.s3_failed",
        msg: "s3 offload failed; falling back to fixture table",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fallback: insert into execution_fixtures.
  const [row] = await db
    .insert(executionFixtures)
    .values({
      tenant_id: params.tenant_id,
      kind: "offload",
      execution_id: params.execution_id,
      step_id: params.step_id ?? null,
      body: params.result as object,
      byte_size: size,
    })
    .returning({ id: executionFixtures.id });
  assertInsertRow(row, "offload");
  return {
    storage_uri: `fixture://${row.id}`,
    preview: serialized.slice(0, STEP_RESULT_PREVIEW_BYTES),
    size_bytes: size,
  };
}
