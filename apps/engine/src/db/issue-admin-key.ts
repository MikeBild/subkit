import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import { sha256Hex } from "../identity/api-key.ts";
import { createDbFromUrl } from "./client.ts";
import { apiKeys, roles, tenants, users } from "./schema/index.ts";

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
      .innerJoin(roles, eq(roles.id, users.role_id))
      .where(
        and(
          eq(users.tenant_id, tenant.id),
          isNull(users.deleted_at),
          isNull(roles.tenant_id),
          eq(roles.name, "admin"),
        ),
      )
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
  let engineUrl = "http://localhost:3000";
  try {
    engineUrl = getConfig().server.public_base_url?.trim() || engineUrl;
  } catch {}
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
