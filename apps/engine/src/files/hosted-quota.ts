import { and, eq, isNull, sql } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Config } from "../config/schema.ts";
import type { Executor } from "../db/client.ts";
import { files, tenants } from "../db/schema/index.ts";

export class HostedFileQuotaError extends Error {
  readonly code = "hosted_file_quota_exhausted";
  constructor(message: string) {
    super(message);
    this.name = "HostedFileQuotaError";
  }
}

export async function assertHostedFileAdmission(
  tx: Executor,
  tenantId: string,
  sizeBytes: number,
  contentHash?: string | null,
): Promise<void> {
  const [tenant] = await tx
    .select({ origin: tenants.origin, status: tenants.status, deleted_at: tenants.deleted_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenant?.origin !== "self_service") return;
  if (tenant.status !== "active" || tenant.deleted_at !== null)
    throw new HostedFileQuotaError("Hosted workspace is unavailable");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw new HostedFileQuotaError("File size must be a nonnegative safe integer");
  if (contentHash) {
    const [existing] = await tx
      .select({ id: files.id })
      .from(files)
      .where(
        and(eq(files.tenant_id, tenantId), eq(files.sha256, contentHash), isNull(files.deleted_at)),
      )
      .limit(1);
    if (existing) return;
  }
  let limits: Config["storage"]["hosted"];
  try {
    limits = getConfig().storage.hosted;
  } catch {
    throw new HostedFileQuotaError("Operator file quotas are not configured");
  }
  const totalLimit = BigInt(limits.tenant_bytes);
  const fileLimit = BigInt(limits.max_file_bytes);
  if (totalLimit <= 0n || fileLimit <= 0n)
    throw new HostedFileQuotaError("Operator file quotas are not configured");
  if (BigInt(sizeBytes) > fileLimit)
    throw new HostedFileQuotaError("File exceeds the operator's hosted per-file byte limit");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-files:${tenantId}`}, 0))`,
  );
  const [usage] = await tx
    .select({ bytes: sql<string>`coalesce(sum(${files.size_bytes}), 0)::text` })
    .from(files)
    .where(eq(files.tenant_id, tenantId));
  if (BigInt(usage?.bytes ?? "0") + BigInt(sizeBytes) > totalLimit)
    throw new HostedFileQuotaError(
      "Hosted workspace file-byte quota is exhausted; retained and staged files still count until object cleanup succeeds",
    );
}
