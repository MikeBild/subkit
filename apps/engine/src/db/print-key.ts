// One-off helper for local smoke tests:
//   bun run apps/engine/src/db/print-key.ts
//
// Issues a fresh API key against the seeded `default` tenant + `default-bot`
// system account, prints the plaintext to stdout, and exits 0. Each
// invocation creates a NEW row — there is no rotation here.

import { eq } from "drizzle-orm";

import { issueApiKey } from "../identity/service.ts";
import { newTraceId, withContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import { closeDb, getDb } from "./client.ts";
import { systemAccounts, tenants } from "./schema/index.ts";

async function main(): Promise<void> {
  const db = getDb();
  const t = await db.select().from(tenants).where(eq(tenants.slug, "default")).limit(1);
  const tenant = t[0];
  if (!tenant) throw new Error("no 'default' tenant — run `bun run db:seed` first");

  const a = await db
    .select()
    .from(systemAccounts)
    .where(eq(systemAccounts.tenant_id, tenant.id))
    .limit(1);
  const account = a[0];
  if (!account) throw new Error("no system account in 'default' tenant");

  const result = await issueApiKey({
    tenant_id: tenant.id,
    owner_kind: "system_account",
    owner_id: account.id,
    actor_id: null,
  });

  // Plaintext goes to stdout in a machine-grep-friendly format.
  process.stdout.write(`${result.plaintext}\n`);
}

await withContext(
  {
    trace_id: newTraceId(),
    tenant_id: "system",
    request_source: "cli",
    actor_id: "print-key",
  },
  async () => {
    try {
      await main();
      await closeDb();
      process.exit(0);
    } catch (err) {
      logger.fatal({
        module: "db",
        action: "print_key.crashed",
        msg: "print-key script crashed",
        error: err instanceof Error ? err.message : String(err),
      });
      await closeDb().catch(() => {});
      process.exit(1);
    }
  },
);
