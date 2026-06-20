// One-off helper: mint a fresh admin API key against an existing
// tenant without re-seeding. Prints the plaintext key once, on
// stdout, for the operator to store in `~/.sk/config.json` or
// feed to `sk login --api-key <key>`.
//
// Two entry points share the same logic:
//
//   1. The compiled engine binary on the host (systemd-deployed):
//        sudo -u subkit /usr/local/bin/engine --issue-admin-key
//        sudo -u subkit /usr/local/bin/engine --issue-admin-key --tenant my-slug
//      (see apps/engine/src/index.ts for the flag wiring)
//
//   2. From a checkout, the same script standalone (uses `bun run`):
//        bun run apps/engine/src/db/issue-admin-key.ts
//        bun run apps/engine/src/db/issue-admin-key.ts --tenant my-slug
//
// Both paths read DATABASE_URL from env. Neither runs migrations,
// re-seeds, or touches any other row — safe on a live database.

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sha256Hex } from "../identity/api-key.ts";
import { createDbFromUrl } from "./client.ts";
import { apiKeys, tenants, users } from "./schema/index.ts";

export type IssuedAdminKey = {
  tenant_slug: string;
  user_email: string;
  key_plaintext: string;
};

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

export function parseIssueAdminKeyArgs(argv: string[]): { tenantSlug: string } {
  let tenantSlug = "default";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant" && argv[i + 1]) {
      tenantSlug = argv[i + 1] as string;
      i++;
    }
  }
  return { tenantSlug };
}

/**
 * Mint a new admin API key for the given tenant. Connects with
 * DATABASE_URL, finds an admin user in the tenant, inserts a key row
 * with `scopes: ["*"]`, and returns the plaintext + identifying
 * metadata. Closes the pool before returning.
 *
 * Throws if DATABASE_URL is unset, the tenant doesn't exist, or the
 * tenant has no admin user.
 */
export async function issueAdminKey(opts: { tenantSlug: string }): Promise<IssuedAdminKey> {
  const { pool, db } = createDbFromUrl(bootstrapDatabaseUrl());
  try {
    const [tenant] = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.slug, opts.tenantSlug))
      .limit(1);
    if (!tenant) {
      throw new Error(`tenant slug '${opts.tenantSlug}' not found`);
    }

    const [adminUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.tenant_id, tenant.id), eq(users.role, "admin")))
      .limit(1);
    if (!adminUser) {
      throw new Error(`no admin user found in tenant '${opts.tenantSlug}'`);
    }

    const key = generate();
    await db.insert(apiKeys).values({
      tenant_id: tenant.id,
      user_id: adminUser.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["*"],
    });

    return {
      tenant_slug: tenant.slug,
      user_email: adminUser.email,
      key_plaintext: key.plaintext,
    };
  } finally {
    await pool.end();
  }
}

export function formatIssuedKeyBanner(issued: IssuedAdminKey): string {
  // Emit a fully copy-paste `sk login` line so logging in from the host is one
  // step. Prefer the configured public base URL; fall back to the local default.
  const engineUrl =
    process.env.SUBKIT_PUBLIC_BASE_URL?.trim() ||
    process.env.PUBLIC_BASE_URL?.trim() ||
    "http://localhost:3000";
  return [
    "",
    "----------------------------------------------------------------",
    " admin api key issued (copy this — it won't be shown again)",
    "----------------------------------------------------------------",
    ` tenant:  ${issued.tenant_slug}`,
    ` user:    ${issued.user_email}`,
    ` key:     ${issued.key_plaintext}`,
    "----------------------------------------------------------------",
    " run this on your machine to log the host `sk` in:",
    `   sk login --engine-url ${engineUrl} --api-key ${issued.key_plaintext}`,
    "",
  ].join("\n");
}

// Standalone-script entry. Skipped when this module is imported (e.g.
// from index.ts wiring `--issue-admin-key`).
if (import.meta.main) {
  const { tenantSlug } = parseIssueAdminKeyArgs(process.argv.slice(2));
  issueAdminKey({ tenantSlug })
    .then((issued) => {
      process.stdout.write(`${formatIssuedKeyBanner(issued)}\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `issue-admin-key: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
