import { and, desc, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { conversations, roles, systemAccounts, tenants, users } from "../db/schema/index.ts";

interface UserProfile {
  email: string;
  role_name: string | null;
}

export interface TenantSummary {
  id: string;
  slug: string;
  display_name: string;
}

interface CockpitIdentity {
  email: string;
  role_name: string | null;
  tenant_id: string;
  tenant_slug: string;
  tenant_display_name: string;
}

interface RecentConversation {
  tenant_id: string;
  id: string;
  title: string | null;
  status: "active" | "awaiting_input" | "committed" | "abandoned";
  updated_at: Date;
}

interface WhoamiProfile {
  email: string | null;
  role_name: string | null;
  tenant_slug: string | null;
}

export async function findUserProfile(
  db: Db,
  tenant_id: string,
  user_id: string,
): Promise<UserProfile | null> {
  const [row] = await db
    .select({
      email: users.email,
      role_name: roles.name,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, tenant_id), eq(users.id, user_id)))
    .limit(1);
  return row ?? null;
}

export async function findActiveUserProfile(
  db: Db,
  tenant_id: string,
  user_id: string,
): Promise<UserProfile | null> {
  const [row] = await db
    .select({ email: users.email, role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(
      and(
        eq(users.id, user_id),
        eq(users.tenant_id, tenant_id),
        isNull(users.deleted_at),
        eq(users.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findSystemAccountRoleName(
  db: Db,
  tenant_id: string,
  system_account_id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role_name: roles.name })
    .from(systemAccounts)
    .leftJoin(roles, eq(roles.id, systemAccounts.role_id))
    .where(and(eq(systemAccounts.tenant_id, tenant_id), eq(systemAccounts.id, system_account_id)))
    .limit(1);
  return row?.role_name ?? null;
}

export async function findTenantSummary(db: Db, tenant_id: string): Promise<TenantSummary | null> {
  const [row] = await db
    .select({ id: tenants.id, slug: tenants.slug, display_name: tenants.display_name })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  return row ?? null;
}

export async function findCockpitIdentity(
  db: Db,
  tenant_id: string,
  user_id: string,
): Promise<CockpitIdentity | null> {
  const [row] = await db
    .select({
      email: users.email,
      role_name: roles.name,
      tenant_id: tenants.id,
      tenant_slug: tenants.slug,
      tenant_display_name: tenants.display_name,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenant_id))
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.id, user_id), eq(users.tenant_id, tenant_id)))
    .limit(1);
  return row ?? null;
}

export async function listRecentOwnedConversations(
  db: Db,
  tenant_id: string,
  owner_id: string,
): Promise<RecentConversation[]> {
  return db
    .select({
      tenant_id: conversations.tenant_id,
      id: conversations.id,
      title: conversations.title,
      status: conversations.status,
      updated_at: conversations.updated_at,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.owner_id, owner_id)))
    .orderBy(desc(conversations.updated_at))
    .limit(10);
}

export async function loadWhoamiProfile(
  db: Db,
  principal: ResolvedPrincipal,
): Promise<WhoamiProfile> {
  let email: string | null = null;
  let roleName: string | null = null;

  if (principal.kind === "user") {
    const row = await findUserProfile(db, principal.tenant_id, principal.id);
    email = row?.email ?? null;
    roleName = row?.role_name ?? null;
  } else if (principal.kind === "system_account") {
    roleName = await findSystemAccountRoleName(db, principal.tenant_id, principal.id);
  }

  const tenant = await findTenantSummary(db, principal.tenant_id);
  return { email, role_name: roleName, tenant_slug: tenant?.slug ?? null };
}
