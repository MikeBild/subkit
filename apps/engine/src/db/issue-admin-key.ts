// One-off helper: mint a fresh admin API key against an existing
// tenant without re-seeding. Prints the plaintext key once, on
// stdout, for the operator to store in `~/.sk/config.json` or
// feed to `sk login --api-key <key>`.
//
// Usage:
//
//   bun run apps/engine/src/db/issue-admin-key.ts
//     → mints a key for tenant slug `default` bound to any admin
//       user in that tenant. Fails loudly if neither exists.
//
//   bun run apps/engine/src/db/issue-admin-key.ts --tenant my-slug
//     → same, but for a specific tenant slug.
//
// The script is intentionally minimal — it does NOT run migrations,
// does NOT re-seed, does NOT touch any other row. Safe to run on a
// live database.

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sha256Hex } from "../identity/api-key.ts";
import { createDbFromUrl } from "./client.ts";
import { apiKeys, tenants, users } from "./schema/index.ts";

function bootstrapDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for issue-admin-key");
  }
  return url;
}

function generate(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: sha256Hex(plaintext),
  };
}

function parseArgs(argv: string[]): { tenantSlug: string } {
  let tenantSlug = "default";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant" && argv[i + 1]) {
      tenantSlug = argv[i + 1] as string;
      i++;
    }
  }
  return { tenantSlug };
}

async function main(): Promise<void> {
  const { tenantSlug } = parseArgs(process.argv.slice(2));
  const { pool, db } = createDbFromUrl(bootstrapDatabaseUrl());
  try {
    const [tenant] = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);
    if (!tenant) {
      process.stderr.write(`issue-admin-key: tenant slug '${tenantSlug}' not found\n`);
      process.exit(2);
    }

    const [adminUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.tenant_id, tenant.id), eq(users.role, "admin")))
      .limit(1);
    if (!adminUser) {
      process.stderr.write(`issue-admin-key: no admin user found in tenant '${tenantSlug}'\n`);
      process.exit(2);
    }

    const key = generate();
    await db.insert(apiKeys).values({
      tenant_id: tenant.id,
      user_id: adminUser.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["*"],
    });

    const banner = [
      "",
      "----------------------------------------------------------------",
      " admin api key issued (copy this — it won't be shown again)",
      "----------------------------------------------------------------",
      ` tenant:  ${tenant.slug}`,
      ` user:    ${adminUser.email}`,
      ` key:     ${key.plaintext}`,
      "----------------------------------------------------------------",
      ` next:    sk login --api-key ${key.plaintext}`,
      "",
    ].join("\n");
    process.stdout.write(`${banner}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`issue-admin-key: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
