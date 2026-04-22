// Idempotent seed.
//
// Split into three phases, each safe to run on every deploy:
//
//   1. seedEssentials — RBAC permission catalog + 6 builtin roles.
//      Always runs. Engine auth breaks without this.
//
//   2. seedTenantBootstrap — creates a tenant + admin user + "bootstrap-admin"
//      system account + admin API key, keyed to BOOTSTRAP_ADMIN_EMAIL.
//      No-op when the env var is unset. Guards key minting on
//      "no existing key for this system account" so re-runs never
//      produce a duplicate key.
//
//   3. seedDevFixtures — the legacy local-dev fixtures: `default` tenant,
//      admin@local user, default-bot system account, a dummy HTTP connector,
//      and a starter global skill. Runs only when NODE_ENV !== "production".
//
// Every created row writes an audit entry. Issued API keys are printed
// to stdout exactly once with a bright warning — they cannot be recovered.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import pc from "picocolors";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { newTraceId, withContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import { seedOnboardingDemo } from "../onboarding/demo-seed.ts";
import {
  backfillRoleIds,
  type SeededRoleIds,
  seedBuiltinRolesAndPermissions,
} from "../rbac/seed.ts";
import { closeDb, type Db, getDb } from "./client.ts";
import {
  apiKeys,
  connectorEnvironments,
  connectors,
  skills,
  systemAccounts,
  tenants,
  users,
} from "./schema/index.ts";

const DEFAULT_TENANT_SLUG = "default";
const BOOTSTRAP_SYS_ACCOUNT_NAME = "bootstrap-admin";
const METRICS_SYS_ACCOUNT_NAME = "metrics-scraper";

type IssuedKey = { label: string; plaintext: string; tenant: string; usage: string };

type SeedResult = {
  status: "seeded" | "already_seeded";
  issued_keys: IssuedKey[];
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  const prefix = plaintext.slice(0, 12);
  const hash = sha256Hex(plaintext);
  return { plaintext, prefix, hash };
}

// --------------------------------------------------------------------------
// Phase 1: RBAC essentials
// --------------------------------------------------------------------------

async function seedEssentials(db: Db): Promise<SeededRoleIds> {
  const rbacIds = await seedBuiltinRolesAndPermissions(db);
  await backfillRoleIds(db, rbacIds);
  return rbacIds;
}

// --------------------------------------------------------------------------
// Phase 2: production tenant bootstrap
// --------------------------------------------------------------------------

async function seedTenantBootstrap(db: Db, rbacIds: SeededRoleIds): Promise<IssuedKey[]> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!email) return [];

  const slug = process.env.BOOTSTRAP_TENANT_SLUG ?? "default";
  const displayName = process.env.BOOTSTRAP_TENANT_NAME ?? "Subkit";
  const createMetricsKey = process.env.BOOTSTRAP_CREATE_METRICS_KEY === "1";

  logger.info({
    module: "db",
    action: "seed.tenant_bootstrap.started",
    msg: "running tenant bootstrap",
    tenant_slug: slug,
    admin_email: email,
  });

  return await db.transaction(async (tx) => {
    const issued: IssuedKey[] = [];

    // --- tenant (upsert by slug) ---
    let [tenant] = await tx.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (!tenant) {
      [tenant] = await tx.insert(tenants).values({ slug, display_name: displayName }).returning();
      if (!tenant) throw new Error("seed: tenant insert returned no row");
      await auditAwait(
        {
          tenant_id: tenant.id,
          actor_type: "system",
          action: AuditAction.TENANT_CREATED,
          resource_type: "tenant",
          resource_id: tenant.id,
          result: "success",
          metadata: { slug: tenant.slug, source: "bootstrap" },
        },
        tx,
      );
    }

    // --- admin user (upsert by tenant_id + email) ---
    let [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenant.id), eq(users.email, email)))
      .limit(1);
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({
          tenant_id: tenant.id,
          email,
          role: "admin",
          role_id: rbacIds.admin,
        })
        .returning();
      if (!user) throw new Error("seed: user insert returned no row");
      await auditAwait(
        {
          tenant_id: tenant.id,
          actor_type: "system",
          action: AuditAction.USER_CREATED,
          resource_type: "user",
          resource_id: user.id,
          result: "success",
          metadata: { email: user.email, role: user.role, source: "bootstrap" },
        },
        tx,
      );
    }

    // --- bootstrap-admin system account (upsert by tenant_id + name) ---
    let [sysAcct] = await tx
      .select()
      .from(systemAccounts)
      .where(
        and(
          eq(systemAccounts.tenant_id, tenant.id),
          eq(systemAccounts.name, BOOTSTRAP_SYS_ACCOUNT_NAME),
        ),
      )
      .limit(1);
    if (!sysAcct) {
      [sysAcct] = await tx
        .insert(systemAccounts)
        .values({
          tenant_id: tenant.id,
          name: BOOTSTRAP_SYS_ACCOUNT_NAME,
          description: "First-deploy admin API key holder",
          role_id: rbacIds.admin,
        })
        .returning();
      if (!sysAcct) throw new Error("seed: bootstrap system_account insert returned no row");
      await auditAwait(
        {
          tenant_id: tenant.id,
          actor_type: "system",
          action: AuditAction.SYSTEM_ACCOUNT_CREATED,
          resource_type: "system_account",
          resource_id: sysAcct.id,
          result: "success",
          metadata: { name: sysAcct.name, source: "bootstrap" },
        },
        tx,
      );
    }

    // --- admin API key: mint only if no un-revoked key exists ---
    const existingAdminKey = await tx
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.system_account_id, sysAcct.id), isNull(apiKeys.revoked_at)))
      .limit(1);
    if (existingAdminKey.length === 0) {
      const key = generateApiKey();
      const [apiKey] = await tx
        .insert(apiKeys)
        .values({
          tenant_id: tenant.id,
          system_account_id: sysAcct.id,
          prefix: key.prefix,
          token_sha256: key.hash,
          scopes: ["*"],
        })
        .returning();
      if (!apiKey) throw new Error("seed: bootstrap api_key insert returned no row");
      await auditAwait(
        {
          tenant_id: tenant.id,
          actor_type: "system",
          action: AuditAction.API_KEY_ISSUED,
          resource_type: "api_key",
          resource_id: apiKey.id,
          result: "success",
          metadata: {
            system_account_id: sysAcct.id,
            prefix: key.prefix,
            source: "bootstrap",
          },
        },
        tx,
      );
      issued.push({
        label: `${BOOTSTRAP_SYS_ACCOUNT_NAME} (admin)`,
        plaintext: key.plaintext,
        tenant: slug,
        usage: `Admin key for tenant "${slug}". Use with: subkit login --api-key <key> / sk login --api-key <key>`,
      });
    }

    // --- optional: metrics scraper system account + scoped key ---
    if (createMetricsKey) {
      let [metricsAcct] = await tx
        .select()
        .from(systemAccounts)
        .where(
          and(
            eq(systemAccounts.tenant_id, tenant.id),
            eq(systemAccounts.name, METRICS_SYS_ACCOUNT_NAME),
          ),
        )
        .limit(1);
      if (!metricsAcct) {
        [metricsAcct] = await tx
          .insert(systemAccounts)
          .values({
            tenant_id: tenant.id,
            name: METRICS_SYS_ACCOUNT_NAME,
            description: "Prometheus scraper — scoped to metrics:read",
            role_id: rbacIds.metrics_scraper,
          })
          .returning();
        if (!metricsAcct) throw new Error("seed: metrics system_account insert returned no row");
        await auditAwait(
          {
            tenant_id: tenant.id,
            actor_type: "system",
            action: AuditAction.SYSTEM_ACCOUNT_CREATED,
            resource_type: "system_account",
            resource_id: metricsAcct.id,
            result: "success",
            metadata: { name: metricsAcct.name, source: "bootstrap" },
          },
          tx,
        );
      }

      const existingMetricsKey = await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.system_account_id, metricsAcct.id), isNull(apiKeys.revoked_at)))
        .limit(1);
      if (existingMetricsKey.length === 0) {
        const mkey = generateApiKey();
        const [metricsApiKey] = await tx
          .insert(apiKeys)
          .values({
            tenant_id: tenant.id,
            system_account_id: metricsAcct.id,
            prefix: mkey.prefix,
            token_sha256: mkey.hash,
            scopes: ["metrics:read"],
          })
          .returning();
        if (!metricsApiKey) throw new Error("seed: metrics api_key insert returned no row");
        await auditAwait(
          {
            tenant_id: tenant.id,
            actor_type: "system",
            action: AuditAction.API_KEY_ISSUED,
            resource_type: "api_key",
            resource_id: metricsApiKey.id,
            result: "success",
            metadata: {
              system_account_id: metricsAcct.id,
              prefix: mkey.prefix,
              scopes: ["metrics:read"],
              source: "bootstrap",
            },
          },
          tx,
        );
        issued.push({
          label: `${METRICS_SYS_ACCOUNT_NAME} (metrics:read)`,
          plaintext: mkey.plaintext,
          tenant: slug,
          usage: `Prometheus scraper key (metrics:read only). Use with: curl -H "Authorization: Bearer <key>" http://localhost:3000/metrics`,
        });
      }
    }

    logger.info({
      module: "db",
      action: "seed.tenant_bootstrap.completed",
      msg: "tenant bootstrap completed",
      tenant_id: tenant.id,
      user_id: user.id,
      system_account_id: sysAcct.id,
      new_keys_issued: issued.length,
    });

    return issued;
  });
}

// --------------------------------------------------------------------------
// Phase 3: dev fixtures (non-production only)
// --------------------------------------------------------------------------

async function seedDevFixtures(db: Db, rbacIds: SeededRoleIds): Promise<IssuedKey[]> {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);

  if (existing.length > 0) {
    logger.info({
      module: "db",
      action: "seed.dev_fixtures.skipped",
      msg: "dev fixtures already present — tenant 'default' exists",
      tenant_id: existing[0]?.id,
    });
    return [];
  }

  logger.info({
    module: "db",
    action: "seed.dev_fixtures.started",
    msg: "seeding local dev fixtures",
  });

  return await db.transaction(async (tx) => {
    // --- tenant ---
    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: DEFAULT_TENANT_SLUG,
        display_name: "Default Tenant",
      })
      .returning();
    if (!tenant) throw new Error("seed: tenant insert returned no row");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.TENANT_CREATED,
        resource_type: "tenant",
        resource_id: tenant.id,
        result: "success",
        metadata: { slug: tenant.slug },
      },
      tx,
    );

    // --- admin user ---
    const [user] = await tx
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: "admin@local",
        role: "admin",
        role_id: rbacIds.admin,
      })
      .returning();
    if (!user) throw new Error("seed: user insert returned no row");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.USER_CREATED,
        resource_type: "user",
        resource_id: user.id,
        result: "success",
        metadata: { email: user.email, role: user.role },
      },
      tx,
    );

    // --- system account ---
    const [sysAcct] = await tx
      .insert(systemAccounts)
      .values({
        tenant_id: tenant.id,
        name: "default-bot",
        description: "Seeded machine account",
        role_id: rbacIds.admin,
      })
      .returning();
    if (!sysAcct) throw new Error("seed: system_account insert returned no row");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.SYSTEM_ACCOUNT_CREATED,
        resource_type: "system_account",
        resource_id: sysAcct.id,
        result: "success",
        metadata: { name: sysAcct.name },
      },
      tx,
    );

    // --- machine API key ---
    const key = generateApiKey();
    const [apiKey] = await tx
      .insert(apiKeys)
      .values({
        tenant_id: tenant.id,
        system_account_id: sysAcct.id,
        prefix: key.prefix,
        token_sha256: key.hash,
        scopes: ["*"],
      })
      .returning();
    if (!apiKey) throw new Error("seed: api_key insert returned no row");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.API_KEY_ISSUED,
        resource_type: "api_key",
        resource_id: apiKey.id,
        result: "success",
        metadata: { system_account_id: sysAcct.id, prefix: key.prefix },
      },
      tx,
    );

    // --- metrics-scraper system account + scoped API key ---
    const [metricsAcct] = await tx
      .insert(systemAccounts)
      .values({
        tenant_id: tenant.id,
        name: "metrics-scraper",
        description: "Prometheus scraper — scoped to metrics:read",
        role_id: rbacIds.metrics_scraper,
      })
      .returning();
    if (!metricsAcct) throw new Error("seed: metrics system_account insert returned no row");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.SYSTEM_ACCOUNT_CREATED,
        resource_type: "system_account",
        resource_id: metricsAcct.id,
        result: "success",
        metadata: { name: metricsAcct.name },
      },
      tx,
    );
    const metricsKey = generateApiKey();
    const [metricsApiKey] = await tx
      .insert(apiKeys)
      .values({
        tenant_id: tenant.id,
        system_account_id: metricsAcct.id,
        prefix: metricsKey.prefix,
        token_sha256: metricsKey.hash,
        scopes: ["metrics:read"],
      })
      .returning();
    if (!metricsApiKey) throw new Error("seed: metrics api_key insert returned no row");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.API_KEY_ISSUED,
        resource_type: "api_key",
        resource_id: metricsApiKey.id,
        result: "success",
        metadata: {
          system_account_id: metricsAcct.id,
          prefix: metricsKey.prefix,
          scopes: ["metrics:read"],
        },
      },
      tx,
    );

    // --- global skill ---
    const [skill] = await tx
      .insert(skills)
      .values({
        tenant_id: tenant.id,
        scope: "global",
        title: "starter-global",
        body: "Starter global skill seeded on first run.",
        lifecycle: "active",
        version: 1,
      })
      .returning();
    if (!skill) throw new Error("seed: skill insert returned no row");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.SKILL_CREATED,
        resource_type: "skill",
        resource_id: skill.id,
        result: "success",
        metadata: { title: skill.title, scope: skill.scope },
      },
      tx,
    );

    // --- dummy HTTP connector + environment ---
    const [connector] = await tx
      .insert(connectors)
      .values({
        tenant_id: tenant.id,
        slug: "dummy-http",
        display_name: "Dummy HTTP",
        driver: "http",
        base_url: "https://example.com",
      })
      .returning();
    if (!connector) throw new Error("seed: connector insert returned no row");
    await tx.insert(connectorEnvironments).values({
      tenant_id: tenant.id,
      connector_id: connector.id,
      environment: "dev",
      overrides: {},
    });
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        action: AuditAction.CONNECTOR_CREATED,
        resource_type: "connector",
        resource_id: connector.id,
        result: "success",
        metadata: { slug: connector.slug, driver: connector.driver },
      },
      tx,
    );

    // --- onboarding demo workflows (3 public-API examples) ---
    await seedOnboardingDemo({ tenant_id: tenant.id }, tx);

    logger.info({
      module: "db",
      action: "seed.dev_fixtures.completed",
      msg: "dev fixtures seeded",
      tenant_id: tenant.id,
      user_id: user.id,
      system_account_id: sysAcct.id,
      api_key_id: apiKey.id,
      skill_id: skill.id,
      connector_id: connector.id,
    });

    return [
      {
        label: "default-bot (admin)",
        plaintext: key.plaintext,
        tenant: DEFAULT_TENANT_SLUG,
        usage: `Dev-only admin key for tenant "${DEFAULT_TENANT_SLUG}". Use with: subkit login --api-key <key> / sk login --api-key <key>`,
      },
      {
        label: "metrics-scraper (metrics:read)",
        plaintext: metricsKey.plaintext,
        tenant: DEFAULT_TENANT_SLUG,
        usage: `Dev-only Prometheus scraper key (metrics:read only). Use with: curl -H "Authorization: Bearer <key>" http://localhost:3000/metrics`,
      },
    ];
  });
}

// --------------------------------------------------------------------------
// Top-level orchestration
// --------------------------------------------------------------------------

export async function seed(): Promise<SeedResult> {
  const db = getDb();
  const rbacIds = await seedEssentials(db);

  const isProd = process.env.NODE_ENV === "production";

  const tenantKeys = await seedTenantBootstrap(db, rbacIds);
  const devKeys = isProd ? [] : await seedDevFixtures(db, rbacIds);

  const issued_keys = [...tenantKeys, ...devKeys];
  return {
    status: issued_keys.length > 0 ? "seeded" : "already_seeded",
    issued_keys,
  };
}

function printIssuedKey({ label, plaintext, tenant, usage }: IssuedKey): void {
  const banner = pc.bgYellow(pc.black(` NEW API KEY ISSUED — ${label} `));
  const warn = pc.bold(pc.yellow("This is the ONLY time this key will be shown. Copy it now."));
  const info = pc.dim(`  Tenant: ${tenant}\n  ${usage}`);
  process.stdout.write(`\n${banner}\n${warn}\n\n  ${pc.cyan(plaintext)}\n\n${info}\n\n`);
}

if (import.meta.main) {
  await withContext(
    {
      trace_id: newTraceId(),
      tenant_id: "system",
      request_source: "cli",
      actor_id: "seed",
    },
    async () => {
      try {
        const result = await seed();
        for (const key of result.issued_keys) {
          printIssuedKey(key);
        }
        if (result.status === "already_seeded") {
          logger.info({
            module: "db",
            action: "seed.idempotent",
            msg: "seed ran with no new rows (idempotent re-run)",
          });
        }
        await closeDb();
        process.exit(0);
      } catch (err) {
        logger.fatal({
          module: "db",
          action: "seed.crashed",
          msg: "seed script crashed",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        await closeDb().catch(() => {});
        process.exit(1);
      }
    },
  );
}
