import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { userIdentities, users } from "../db/schema/index.ts";
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

export interface ResolveProviderIdentityOptions {
  tenantId: string;
  providerId: string;
  subject: string;
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
    const existing = await tx
      .select({ user: users, identityId: userIdentities.id })
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
      await tx
        .update(userIdentities)
        .set({ email, last_seen_at: new Date(), updated_at: new Date() })
        .where(
          and(
            eq(userIdentities.tenant_id, options.tenantId),
            eq(userIdentities.id, existing[0].identityId),
          ),
        );
      return { user: existing[0].user, createdUser: false, linkedIdentity: false };
    }

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
