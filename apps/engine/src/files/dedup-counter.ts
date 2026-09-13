// Per-tenant dedup-hit persistence helper.
//
// The `dedup_hits` field on `GET /v1/files/stats` is owned by this
// counter, not by `audit_log`. Reading the audit ledger would couple
// compliance retention to dashboard accuracy — a shorter audit
// retention would silently drop the stat. The `files_dedup_seen` table
// owns the counter independently: one UPSERT-bumped row per tenant,
// and the stats query is a single indexed lookup.
//
// Call this helper on EVERY dedup short-circuit path:
//   - inline upload sha256-match (POST /v1/files/inline)
//   - batch-create sha256-match (POST /v1/files/batch-create)
//   - finalize sibling-dedup collapse (POST /v1/files/{id}/finalize)
// Pair with the existing `recordFileDedupHit()` Prometheus increment —
// the counter is process-global; the row is per-tenant.

import { sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { filesDedupSeen } from "../db/schema/files.ts";

/** UPSERT-bump the `files_dedup_seen` row for a tenant by 1. Idempotent
 *  in the sense of "always succeeds"; not idempotent in the counter
 *  value (each call bumps). The caller must invoke exactly once per
 *  dedup short-circuit. */
export async function recordFilesDedupSeen(db: Db, tenant_id: string): Promise<void> {
  await db
    .insert(filesDedupSeen)
    .values({ tenant_id, count: 1, updated_at: new Date() })
    .onConflictDoUpdate({
      target: filesDedupSeen.tenant_id,
      set: {
        count: sql`${filesDedupSeen.count} + 1`,
        updated_at: new Date(),
      },
    });
}
