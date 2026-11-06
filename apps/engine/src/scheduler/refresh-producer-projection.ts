import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { connectors, knowledgeSources } from "../db/schema/index.ts";
import type { DocSourceType } from "../docs-ingestion/index.ts";
import type { SweepCandidate, SweepLease } from "./sweep-cursor.ts";

export const REFRESH_CRON_MAX_BYTES = 16 * 1024;
export const REFRESH_SOURCE_TYPE_MAX_BYTES = 64;
export const REFRESH_ADDRESS_MAX_BYTES = 1024 * 1024;
export type RefreshProducer = "docs" | "knowledge";
const refreshSourceType = z.enum([
  "openapi",
  "google_discovery",
  "markdown",
  "llms_txt",
  "graphql",
  "postgres",
  "cascade",
]);
const textWithin = (max: number) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= max);
const projectionSchema = z
  .object({
    cron: textWithin(REFRESH_CRON_MAX_BYTES).nullable(),
    last_fired_at: z
      .string()
      .max(40)
      .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/)
      .nullable(),
    source_type: textWithin(REFRESH_SOURCE_TYPE_MAX_BYTES).nullable(),
    address: textWithin(REFRESH_ADDRESS_MAX_BYTES).nullable(),
  })
  .strict();
type RefreshInput = {
  cron: string;
  last_fired_at: Date | null;
  address: string;
};
type RefreshParseResult =
  | {
      kind: "ready";
      producer: "docs";
      input: RefreshInput & { source_type: Exclude<DocSourceType, "file_upload"> };
    }
  | { kind: "ready"; producer: "knowledge"; input: RefreshInput & { source_type: "url" } }
  | { kind: "unsupported" };

export function parseRefreshProjection(
  producer: RefreshProducer,
  value: unknown,
): RefreshParseResult {
  const parsed = projectionSchema.safeParse(value);
  if (!parsed.success) return { kind: "unsupported" };
  const row = parsed.data;
  if (!row.cron?.trim() || !row.address) return { kind: "unsupported" };
  const last = row.last_fired_at === null ? null : new Date(row.last_fired_at);
  if (last !== null && !Number.isFinite(last.getTime())) return { kind: "unsupported" };
  const input = { cron: row.cron, last_fired_at: last, address: row.address };
  if (producer === "knowledge")
    return row.source_type === "url"
      ? { kind: "ready", producer, input: { ...input, source_type: "url" } }
      : { kind: "unsupported" };
  const source = refreshSourceType.safeParse(row.source_type);
  return source.success
    ? { kind: "ready", producer, input: { ...input, source_type: source.data } }
    : { kind: "unsupported" };
}

function boundedText(value: SQL, max: number): SQL {
  return sql`CASE WHEN octet_length(${value}) <= ${max} THEN ${value} ELSE NULL END`;
}

export function refreshProjectionQuery(
  producer: RefreshProducer,
  candidate: SweepCandidate,
  lease: SweepLease,
): SQL {
  if (producer === "docs") {
    const sourceType = sql`CASE WHEN jsonb_typeof(config -> 'docs_source_type') = 'string'
      THEN config ->> 'docs_source_type' ELSE NULL END`;
    const address = sql`CASE WHEN jsonb_typeof(config -> 'docs_source_url') = 'string'
      THEN config ->> 'docs_source_url' ELSE NULL END`;
    return sql`SELECT
      ${boundedText(sql`auto_refresh_cron`, REFRESH_CRON_MAX_BYTES)} AS cron,
      last_ingested_at::text AS last_fired_at,
      ${boundedText(sourceType, REFRESH_SOURCE_TYPE_MAX_BYTES)} AS source_type,
      ${boundedText(address, REFRESH_ADDRESS_MAX_BYTES)} AS address
      FROM ${connectors}
      WHERE id = ${candidate.id}::uuid AND tenant_id = ${candidate.tenant_id}::uuid
        AND deleted_at IS NULL AND auto_refresh_cron IS NOT NULL
        AND created_at <= ${lease.epoch_cutoff_at} AND id <= ${lease.epoch_upper_id}::uuid
        ${lease.after_id ? sql`AND id > ${lease.after_id}::uuid` : sql``}
      LIMIT 1 FOR UPDATE`;
  }
  return sql`SELECT
    ${boundedText(sql`refresh_cron`, REFRESH_CRON_MAX_BYTES)} AS cron,
    last_refreshed_at::text AS last_fired_at,
    'url'::text AS source_type,
    ${boundedText(sql`source_uri`, REFRESH_ADDRESS_MAX_BYTES)} AS address
    FROM ${knowledgeSources}
    WHERE id = ${candidate.id}::uuid AND tenant_id = ${candidate.tenant_id}::uuid
      AND refresh_strategy = 'scheduled' AND source_type = 'url'
      AND status IN ('active', 'error') AND deleted_at IS NULL AND refresh_cron IS NOT NULL
      AND created_at <= ${lease.epoch_cutoff_at} AND id <= ${lease.epoch_upper_id}::uuid
      ${lease.after_id ? sql`AND id > ${lease.after_id}::uuid` : sql``}
    LIMIT 1 FOR UPDATE`;
}
