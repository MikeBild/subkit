import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import pc from "picocolors";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { logger } from "../logging/logger.ts";
import {
  backfillSystemAccountRoleIds,
  type SeededRoleIds,
  seedBuiltinRolesAndPermissions,
} from "../rbac/seed.ts";
import { lockCatalogVocabulary } from "./catalog-vocabulary.ts";
import type { Db, Executor } from "./client.ts";
import {
  apiKeys,
  notificationRules,
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

async function seedEssentials(db: Db): Promise<SeededRoleIds> {
  const rbacIds = await seedBuiltinRolesAndPermissions(db);
  await backfillSystemAccountRoleIds(db, rbacIds);
  return rbacIds;
}

export const DEFAULT_CLI_INBOX_EVENT_PATTERN =
  "execution.failed,connector.oauth.callback_failed,connector.auth_failed,connector.health_changed,patch.proposed";

export async function seedDefaultCliNotificationRule(
  tx: Executor,
  tenant_id: string,
): Promise<void> {
  const existing = await tx
    .select({ id: notificationRules.id })
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.tenant_id, tenant_id),
        eq(notificationRules.target_workspace_id, "_cli"),
        eq(notificationRules.target_channel_id, "_inbox"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  await tx.insert(notificationRules).values({
    tenant_id,
    name: "sk CLI inbox (default)",
    event_pattern: DEFAULT_CLI_INBOX_EVENT_PATTERN,
    workflow_pattern: "*",
    severity: "info",
    request_source_filter: null,
    target_workspace_id: "_cli",
    target_channel_id: "_inbox",
    active: true,
  });
}

export interface TenantBootstrapPayload {
  admin_email: string;
  tenant_name: string;
  tenant_slug: string;
  create_metrics_key?: boolean;
}

export interface TenantBootstrapResult {
  tenant_id: string;
  user_id: string;
  api_key: { plaintext: string; prefix: string } | null;
  issued_keys: IssuedKey[];
}

export async function seedTenantBootstrap(
  db: Db,
  rbacIds: SeededRoleIds,
  payload: TenantBootstrapPayload,
): Promise<TenantBootstrapResult> {
  const email = payload.admin_email;
  const slug = payload.tenant_slug;
  const displayName = payload.tenant_name;
  const createMetricsKey = payload.create_metrics_key ?? false;

  logger.info({
    module: "db",
    action: "seed.tenant_bootstrap.started",
    msg: "running tenant bootstrap",
    tenant_slug: slug,
    admin_email: email,
    source: "payload",
  });

  return await db.transaction(async (tx) => {
    const issued: IssuedKey[] = [];
    let adminApiKey: { plaintext: string; prefix: string } | null = null;

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

    await lockCatalogVocabulary(tx, tenant.id);
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
          metadata: { email: user.email, role_id: user.role_id, source: "bootstrap" },
        },
        tx,
      );
    }

    await seedDefaultCliNotificationRule(tx, tenant.id);

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

    // tenant-filter:exempt — bootstrap path; system_account_id FK is tenant-scoped and uniqueness is anchored by it
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
        usage: `Admin key for tenant "${slug}". Use with: sk login --api-key <key>`,
      });
      adminApiKey = { plaintext: key.plaintext, prefix: key.prefix };
    }

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

      // tenant-filter:exempt — bootstrap path; system_account_id FK is tenant-scoped and uniqueness is anchored by it
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

    return {
      tenant_id: tenant.id,
      user_id: user.id,
      api_key: adminApiKey,
      issued_keys: issued,
    };
  });
}

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
    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: DEFAULT_TENANT_SLUG,
        display_name: "Default Tenant",
      })
      .returning();
    if (!tenant) throw new Error("seed: tenant insert returned no row");
    await lockCatalogVocabulary(tx, tenant.id);
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

    const [user] = await tx
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: "admin@local",
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
        metadata: { email: user.email, role_id: user.role_id },
      },
      tx,
    );

    await seedDefaultCliNotificationRule(tx, tenant.id);

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

    logger.info({
      module: "db",
      action: "seed.dev_fixtures.completed",
      msg: "dev fixtures seeded",
      tenant_id: tenant.id,
      user_id: user.id,
      system_account_id: sysAcct.id,
      api_key_id: apiKey.id,
      skill_id: skill.id,
    });

    return [
      {
        label: "default-bot (admin)",
        plaintext: key.plaintext,
        tenant: DEFAULT_TENANT_SLUG,
        usage: `Dev-only admin key for tenant "${DEFAULT_TENANT_SLUG}". Use with: sk login --api-key <key>`,
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

export async function seedAtBoot(db: Db): Promise<SeedResult> {
  const rbacIds = await seedEssentials(db);
  const isProd = process.env.NODE_ENV === "production";
  const devKeys = isProd ? [] : await seedDevFixtures(db, rbacIds);
  return {
    status: devKeys.length > 0 ? "seeded" : "already_seeded",
    issued_keys: devKeys,
  };
}

export function printIssuedKey(
  { label, plaintext, tenant, usage }: IssuedKey,
  opts: { source?: "boot" | "cli" } = {},
): void {
  const sourceTag = opts.source ? ` (via ${opts.source})` : "";
  const banner = pc.bgYellow(pc.black(` NEW API KEY ISSUED — ${label}${sourceTag} `));
  const warn = pc.bold(pc.yellow("This is the ONLY time this key will be shown. Copy it now."));
  const info = pc.dim(`  Tenant: ${tenant}\n  ${usage}`);
  process.stdout.write(`\n${banner}\n${warn}\n\n  ${pc.cyan(plaintext)}\n\n${info}\n\n`);
}
