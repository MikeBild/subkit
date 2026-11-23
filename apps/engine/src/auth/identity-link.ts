import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  productIdentityTombstones,
  roles,
  tenants,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { DomainRefusal } from "../logging/index.ts";
import { builtinRoleId } from "../rbac/roles.ts";

export class IdentityLinkConflictError extends Error {
  constructor() {
    super("account already linked to a different identity");
    this.name = "IdentityLinkConflictError";
  }
}

export class SignupDisabledError extends Error {
  constructor() {
    super("signups are disabled and this identity matches no existing account");
    this.name = "SignupDisabledError";
  }
}

async function assertTenantLocalIdentityAllowed(exec: Executor, tenantId: string): Promise<void> {
  const [tenant] = await exec
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenant?.origin === "self_service") throw new IdentityLinkConflictError();
}

interface ResolveProviderIdentityOptions {
  tenantId: string;
  providerId: string;
  subject: string;
  issuerUrl?: string;
  productId?: string;
  email: string;
  linkByEmail: boolean;
  allowCreate: boolean;
}

export async function resolveProviderIdentity(
  db: Db,
  options: ResolveProviderIdentityOptions,
): Promise<{
  user: typeof users.$inferSelect;
  createdUser: boolean;
  linkedIdentity: boolean;
}> {
  const email = options.email.trim().toLowerCase();

  return db.transaction(async (tx) => {
    await assertTenantLocalIdentityAllowed(tx, options.tenantId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${options.tenantId}:${options.providerId}:identity`}, 0))`,
    );
    const existing = await tx
      .select({
        user: users,
        identityId: userIdentities.id,
        issuer: userIdentities.issuer_url,
        product: userIdentities.product_id,
      })
      .from(userIdentities)
      .innerJoin(
        users,
        and(eq(users.tenant_id, userIdentities.tenant_id), eq(users.id, userIdentities.user_id)),
      )
      .where(
        and(
          eq(userIdentities.tenant_id, options.tenantId),
          eq(userIdentities.provider_id, options.providerId),
          eq(userIdentities.subject, options.subject),
        ),
      )
      .limit(1);
    if (existing[0]) {
      const binding = existing[0];
      if (
        binding.user.deleted_at ||
        binding.user.status === "disabled" ||
        (binding.issuer !== null && binding.issuer !== (options.issuerUrl ?? null)) ||
        binding.product !== (options.productId ?? null) ||
        (options.productId && binding.issuer === null)
      )
        throw new IdentityLinkConflictError();
      const pinIssuer = binding.issuer === null && options.issuerUrl !== undefined;
      await tx
        .update(userIdentities)
        .set({
          email,
          ...(pinIssuer ? { issuer_url: options.issuerUrl } : {}),
          last_seen_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(userIdentities.tenant_id, options.tenantId),
            eq(userIdentities.id, existing[0].identityId),
          ),
        );
      if (pinIssuer)
        await auditAwait(
          {
            tenant_id: options.tenantId,
            actor_type: "user",
            actor_id: binding.user.id,
            action: AuditAction.USER_IDENTITY_LINKED,
            resource_type: "user",
            resource_id: binding.user.id,
            result: "success",
            metadata: {
              provider_id: options.providerId,
              issuer_url: options.issuerUrl,
              product_id: null,
              source: "legacy_identity_pin",
            },
          },
          tx,
        );
      return { user: binding.user, createdUser: false, linkedIdentity: false };
    }

    if (options.productId) throw new SignupDisabledError();
    let user = options.linkByEmail
      ? (
          await tx
            .select()
            .from(users)
            .where(and(eq(users.tenant_id, options.tenantId), eq(users.email, email)))
            .limit(1)
        )[0]
      : undefined;
    let createdUser = false;
    if (!user && !options.allowCreate) {
      throw new SignupDisabledError();
    }
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({
          tenant_id: options.tenantId,
          email,
          role_id: await builtinRoleId(tx, "member"),
        })
        .onConflictDoNothing({ target: [users.tenant_id, users.email] })
        .returning();
      createdUser = Boolean(user);
      if (!user) {
        if (!options.linkByEmail) throw new IdentityLinkConflictError();
        [user] = await tx
          .select()
          .from(users)
          .where(and(eq(users.tenant_id, options.tenantId), eq(users.email, email)))
          .limit(1);
      }
    }
    if (!user) throw new Error("failed to resolve user row");

    const providerBinding = await tx
      .select({ subject: userIdentities.subject })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.tenant_id, options.tenantId),
          eq(userIdentities.user_id, user.id),
          eq(userIdentities.provider_id, options.providerId),
        ),
      )
      .limit(1);
    if (providerBinding[0] && providerBinding[0].subject !== options.subject) {
      throw new IdentityLinkConflictError();
    }

    const [identity] = await tx
      .insert(userIdentities)
      .values({
        tenant_id: options.tenantId,
        user_id: user.id,
        provider_id: options.providerId,
        issuer_url: options.issuerUrl ?? null,
        product_id: options.productId ?? null,
        subject: options.subject,
        email,
      })
      .onConflictDoNothing({
        target: [userIdentities.tenant_id, userIdentities.provider_id, userIdentities.subject],
      })
      .returning();
    if (!identity) {
      const canonical = await tx
        .select({ userId: userIdentities.user_id })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.tenant_id, options.tenantId),
            eq(userIdentities.provider_id, options.providerId),
            eq(userIdentities.subject, options.subject),
          ),
        )
        .limit(1);
      if (canonical[0]?.userId !== user.id) throw new IdentityLinkConflictError();
    }

    return { user, createdUser, linkedIdentity: !createdUser };
  });
}

export class ProductIdentityErasedError extends DomainRefusal {
  constructor() {
    super("identity_erased", "this product identity was erased");
    this.name = "ProductIdentityErasedError";
  }
}

interface ResolveProductBearerIdentityOptions {
  tenantId: string;
  providerId: string;
  issuerUrl: string;
  productId: string;
  subject: string;
  issuedAt: Date;
  now?: Date;
}

interface ProductBearerIdentity {
  userId: string;
  identityId: string;
  role: string | null;
  createdUser: boolean;
}

const LAST_SEEN_INTERVAL_MS = 10 * 60 * 1000;

export function productSubjectDigest(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}

function productPlaceholderEmail(providerId: string, subject: string): string {
  return `${providerId}:${subject}@invalid`;
}

async function productTombstone(
  exec: Executor,
  options: ResolveProductBearerIdentityOptions,
): Promise<Date | null> {
  const [row] = await exec
    .select({ erased_at: productIdentityTombstones.erased_at })
    .from(productIdentityTombstones)
    .where(
      and(
        eq(productIdentityTombstones.tenant_id, options.tenantId),
        eq(productIdentityTombstones.provider_id, options.providerId),
        eq(productIdentityTombstones.subject_sha256, productSubjectDigest(options.subject)),
      ),
    )
    .limit(1);
  return row?.erased_at ?? null;
}

async function productBinding(exec: Executor, options: ResolveProductBearerIdentityOptions) {
  const [row] = await exec
    .select({
      userId: users.id,
      status: users.status,
      deletedAt: users.deleted_at,
      role: roles.name,
      identityId: userIdentities.id,
      issuer: userIdentities.issuer_url,
      product: userIdentities.product_id,
      lastSeenAt: userIdentities.last_seen_at,
    })
    .from(userIdentities)
    .innerJoin(
      users,
      and(eq(users.tenant_id, userIdentities.tenant_id), eq(users.id, userIdentities.user_id)),
    )
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(
      and(
        eq(userIdentities.tenant_id, options.tenantId),
        eq(userIdentities.provider_id, options.providerId),
        eq(userIdentities.subject, options.subject),
      ),
    )
    .limit(1);
  return row;
}

function acceptBinding(
  binding: NonNullable<Awaited<ReturnType<typeof productBinding>>>,
  options: ResolveProductBearerIdentityOptions,
): void {
  if (
    binding.deletedAt ||
    binding.status !== "active" ||
    binding.issuer !== options.issuerUrl ||
    binding.product !== options.productId
  )
    throw new IdentityLinkConflictError();
}

export async function resolveProductBearerIdentity(
  db: Db,
  options: ResolveProductBearerIdentityOptions,
): Promise<ProductBearerIdentity> {
  await assertTenantLocalIdentityAllowed(db, options.tenantId);
  const now = options.now ?? new Date();
  const existing = await productBinding(db, options);
  if (existing) {
    acceptBinding(existing, options);
    if (now.getTime() - existing.lastSeenAt.getTime() >= LAST_SEEN_INTERVAL_MS) {
      await db
        .update(userIdentities)
        .set({ last_seen_at: now })
        .where(
          and(
            eq(userIdentities.tenant_id, options.tenantId),
            eq(userIdentities.id, existing.identityId),
          ),
        );
    }
    return {
      userId: existing.userId,
      identityId: existing.identityId,
      role: existing.role,
      createdUser: false,
    };
  }
  return db.transaction(async (tx) => {
    await assertTenantLocalIdentityAllowed(tx, options.tenantId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${options.tenantId}:${options.providerId}:identity`}, 0))`,
    );
    const raced = await productBinding(tx, options);
    if (raced) {
      acceptBinding(raced, options);
      return {
        userId: raced.userId,
        identityId: raced.identityId,
        role: raced.role,
        createdUser: false,
      };
    }
    const erasedAt = await productTombstone(tx, options);
    if (erasedAt && options.issuedAt.getTime() <= erasedAt.getTime())
      throw new ProductIdentityErasedError();
    const email = productPlaceholderEmail(options.providerId, options.subject);
    const roleId = await builtinRoleId(tx, "member");
    const [user] = await tx
      .insert(users)
      .values({ tenant_id: options.tenantId, email, role_id: roleId })
      .onConflictDoNothing({ target: [users.tenant_id, users.email] })
      .returning({ id: users.id });
    if (!user) throw new IdentityLinkConflictError();
    const [identity] = await tx
      .insert(userIdentities)
      .values({
        tenant_id: options.tenantId,
        user_id: user.id,
        provider_id: options.providerId,
        issuer_url: options.issuerUrl,
        product_id: options.productId,
        subject: options.subject,
        email,
        last_seen_at: now,
      })
      .returning({ id: userIdentities.id });
    if (!identity) throw new IdentityLinkConflictError();
    const [role] = await tx
      .select({ name: roles.name })
      .from(roles)
      .where(and(isNull(roles.tenant_id), eq(roles.id, roleId)))
      .limit(1);
    await auditAwait(
      {
        tenant_id: options.tenantId,
        actor_type: "system",
        action: AuditAction.USER_CREATED,
        resource_type: "user",
        resource_id: user.id,
        result: "success",
        metadata: { source: options.providerId, product_id: options.productId },
      },
      tx,
    );
    return {
      userId: user.id,
      identityId: identity.id,
      role: role?.name ?? null,
      createdUser: true,
    };
  });
}
