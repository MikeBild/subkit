import { eq } from "drizzle-orm";
import { issueApiKey } from "../identity/service.ts";
import { newTraceId, withContext } from "../logging/context.ts";
import { logger } from "../logging/index.ts";
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

  const result = await issueApiKey(
    {
      issuer: { kind: "system" },
      tenant_id: tenant.id,
      owner_kind: "system_account",
      owner_id: account.id,
      actor: { kind: "system", id: null },
    },
    db,
  );

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
