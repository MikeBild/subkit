import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import {
  type NotificationSchedulePreference,
  tenants,
  type UserSetupPreferencesRow,
  userSetupPreferences,
  users,
} from "../db/schema/index.ts";

export const RECOMMENDED_SETUP = {
  default_chat_mode: "auto",
  default_environment: "dev",
  approver: { kind: "self" },
  notifications: { mode: "immediately" },
  critical_breakthrough: false,
} as const;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type SetupChatMode = "ask" | "auto" | "plan";
export type SetupEnvironment = "dev" | "prod";

export type SetupApprover =
  | { kind: "self" }
  | {
      kind: "teammate";
      email: string;
      user_id: string | null;
      invite_id: string | null;
    };

export interface SetupPreferences {
  default_chat_mode: SetupChatMode;
  default_environment: SetupEnvironment;
  approver: SetupApprover;
  notifications: NotificationSchedulePreference;
  timezone: string | null;
  critical_breakthrough: boolean;
  first_job: string | null;
  services: string[];
  unset: Array<"default_chat_mode" | "default_environment" | "approver" | "notifications">;
  updated_at: Date | null;
}

export interface SetupPatch {
  default_chat_mode?: SetupChatMode;
  default_environment?: SetupEnvironment;
  approver?: SetupApprover;
  notifications?: NotificationSchedulePreference;
  timezone?: string | null;
  critical_breakthrough?: boolean;
  first_job?: string | null;
  services?: string[];
}

export interface SetupOwner {
  readonly tenant_id: string;
  readonly user_id: string;
}

function approverOf(row: UserSetupPreferencesRow | undefined): SetupApprover | null {
  if (!row?.approver_kind) return null;
  if (row.approver_kind === "self" || !row.approver_email) return { kind: "self" };
  return {
    kind: "teammate",
    email: row.approver_email,
    user_id: row.approver_user_id,
    invite_id: row.approver_invite_id,
  };
}

export function setupFromRow(row: UserSetupPreferencesRow | undefined): SetupPreferences {
  const approver = approverOf(row);
  const unset: SetupPreferences["unset"] = [];
  if (!row?.default_chat_mode) unset.push("default_chat_mode");
  if (!row?.default_environment) unset.push("default_environment");
  if (!approver) unset.push("approver");
  if (!row?.notification_schedule) unset.push("notifications");
  return {
    default_chat_mode: row?.default_chat_mode ?? RECOMMENDED_SETUP.default_chat_mode,
    default_environment: row?.default_environment ?? RECOMMENDED_SETUP.default_environment,
    approver: approver ?? RECOMMENDED_SETUP.approver,
    notifications: row?.notification_schedule ?? RECOMMENDED_SETUP.notifications,
    timezone: row?.timezone ?? null,
    critical_breakthrough: row?.critical_breakthrough ?? RECOMMENDED_SETUP.critical_breakthrough,
    first_job: row?.first_job ?? null,
    services: row?.services ?? [],
    unset,
    updated_at: row?.updated_at ?? null,
  };
}

async function findRow(
  db: Executor,
  owner: SetupOwner,
): Promise<UserSetupPreferencesRow | undefined> {
  const [row] = await db
    .select()
    .from(userSetupPreferences)
    .where(
      and(
        eq(userSetupPreferences.tenant_id, owner.tenant_id),
        eq(userSetupPreferences.user_id, owner.user_id),
      ),
    )
    .limit(1);
  return row;
}

export async function readSetupPreferences(
  db: Executor,
  owner: SetupOwner,
): Promise<SetupPreferences> {
  return setupFromRow(await findRow(db, owner));
}

export async function storedDefaultChatMode(
  db: Executor,
  owner: SetupOwner,
): Promise<SetupChatMode | null> {
  const [row] = await db
    .select({ mode: userSetupPreferences.default_chat_mode })
    .from(userSetupPreferences)
    .where(
      and(
        eq(userSetupPreferences.tenant_id, owner.tenant_id),
        eq(userSetupPreferences.user_id, owner.user_id),
      ),
    )
    .limit(1);
  return row?.mode ?? null;
}

export async function storedDefaultEnvironment(
  db: Executor,
  owner: SetupOwner,
): Promise<SetupEnvironment | null> {
  const [row] = await db
    .select({ environment: userSetupPreferences.default_environment })
    .from(userSetupPreferences)
    .where(
      and(
        eq(userSetupPreferences.tenant_id, owner.tenant_id),
        eq(userSetupPreferences.user_id, owner.user_id),
      ),
    )
    .limit(1);
  return row?.environment ?? null;
}

export async function personalDefaultEnvironment(
  db: Executor,
  tenant_id: string,
  principal: Pick<ResolvedPrincipal, "kind" | "id" | "tenant_id"> | null | undefined,
): Promise<SetupEnvironment | null> {
  if (principal?.kind !== "user" || principal.tenant_id !== tenant_id) return null;
  return storedDefaultEnvironment(db, { tenant_id, user_id: principal.id });
}

export interface PushPreference {
  readonly schedule: NotificationSchedulePreference;
  readonly timezone: string;
  readonly critical_breakthrough: boolean;
  readonly last_digest_at: Date | null;
  readonly approver_user_id: string | null;
}

export async function readPushPreference(db: Executor, owner: SetupOwner): Promise<PushPreference> {
  const [row, tenant] = await Promise.all([
    findRow(db, owner),
    db
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, owner.tenant_id))
      .limit(1),
  ]);
  const workspace = tenant[0]?.timezone ?? "UTC";
  const personal = row?.timezone ?? null;
  const delegated =
    row?.approver_kind === "teammate" && row.approver_user_id !== owner.user_id
      ? row.approver_user_id
      : null;
  return {
    schedule: row?.notification_schedule ?? RECOMMENDED_SETUP.notifications,
    timezone:
      personal && isTimeZone(personal) ? personal : isTimeZone(workspace) ? workspace : "UTC",
    critical_breakthrough: row?.critical_breakthrough ?? false,
    last_digest_at: row?.last_digest_at ?? null,
    approver_user_id: delegated,
  };
}

export interface ApproverPerson {
  readonly user_id: string;
  readonly name: string;
  readonly email: string;
}

export async function activeApprover(
  db: Executor,
  owner: SetupOwner,
): Promise<ApproverPerson | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      display_name: users.display_name,
    })
    .from(userSetupPreferences)
    .innerJoin(
      users,
      and(
        eq(users.id, userSetupPreferences.approver_user_id),
        eq(users.tenant_id, userSetupPreferences.tenant_id),
      ),
    )
    .where(
      and(
        eq(userSetupPreferences.tenant_id, owner.tenant_id),
        eq(userSetupPreferences.user_id, owner.user_id),
        eq(userSetupPreferences.approver_kind, "teammate"),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  if (!row || row.id === owner.user_id) return null;
  return { user_id: row.id, email: row.email, name: row.display_name?.trim() || row.email };
}

export async function findTeammateByEmail(
  db: Executor,
  tenant_id: string,
  email: string,
): Promise<{ id: string; email: string; status: string } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(
      and(
        eq(users.tenant_id, tenant_id),
        sql`lower(${users.email}) = ${email.trim().toLowerCase()}`,
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  return row ?? null;
}

export const APPROVER_PERMISSIONS = [
  "conversation:approve",
  "task:grant",
  "workflow:write",
] as const;

export async function linkJoinedApprover(
  db: Executor,
  person: { tenant_id: string; id: string; email: string },
): Promise<number> {
  const linked = await db
    .update(userSetupPreferences)
    .set({ approver_user_id: person.id, updated_at: sql`now()` })
    .where(
      and(
        eq(userSetupPreferences.tenant_id, person.tenant_id),
        eq(userSetupPreferences.approver_kind, "teammate"),
        isNull(userSetupPreferences.approver_user_id),
        sql`lower(${userSetupPreferences.approver_email}) = ${person.email.trim().toLowerCase()}`,
        sql`${userSetupPreferences.user_id} <> ${person.id}`,
      ),
    )
    .returning({ user_id: userSetupPreferences.user_id });
  for (const row of linked) {
    await auditAwait(
      {
        tenant_id: person.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.USER_SETUP_UPDATED,
        resource_type: "user",
        resource_id: row.user_id,
        result: "success",
        before: { approver_user_id: null },
        after: { approver_user_id: person.id },
        metadata: { source: "approver_joined", fields: ["approver"] },
      },
      db,
    );
  }
  return linked.length;
}

function audited(setup: SetupPreferences): Record<string, unknown> {
  return {
    default_chat_mode: setup.default_chat_mode,
    default_environment: setup.default_environment,
    approver_kind: setup.approver.kind,
    approver_user_id: setup.approver.kind === "teammate" ? setup.approver.user_id : null,
    notification_mode: setup.notifications.mode,
    timezone: setup.timezone,
    critical_breakthrough: setup.critical_breakthrough,
    first_job: setup.first_job,
    services: setup.services,
  };
}

export async function writeSetupPreferences(
  db: Executor,
  owner: SetupOwner,
  patch: SetupPatch,
): Promise<SetupPreferences | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenant_id, owner.tenant_id),
          eq(users.id, owner.user_id),
          isNull(users.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!user) return null;
    const before = await findRow(tx, owner);
    const approver = patch.approver;
    const values = {
      ...(patch.default_chat_mode !== undefined
        ? { default_chat_mode: patch.default_chat_mode }
        : {}),
      ...(patch.default_environment !== undefined
        ? { default_environment: patch.default_environment }
        : {}),
      ...(approver !== undefined
        ? {
            approver_kind: approver.kind,
            approver_email: approver.kind === "teammate" ? approver.email : null,
            approver_user_id: approver.kind === "teammate" ? approver.user_id : null,
            approver_invite_id: approver.kind === "teammate" ? approver.invite_id : null,
          }
        : {}),
      ...(patch.notifications !== undefined
        ? { notification_schedule: patch.notifications, last_digest_at: sql`now()` }
        : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.critical_breakthrough !== undefined
        ? { critical_breakthrough: patch.critical_breakthrough }
        : {}),
      ...(patch.first_job !== undefined ? { first_job: patch.first_job } : {}),
      ...(patch.services !== undefined ? { services: [...new Set(patch.services)] } : {}),
    };
    const [row] = await tx
      .insert(userSetupPreferences)
      .values({ tenant_id: owner.tenant_id, user_id: owner.user_id, ...values })
      .onConflictDoUpdate({
        target: [userSetupPreferences.tenant_id, userSetupPreferences.user_id],
        set: { ...values, updated_at: sql`now()` },
      })
      .returning();
    const after = setupFromRow(row);
    await auditAwait(
      {
        tenant_id: owner.tenant_id,
        actor_type: "user",
        actor_id: owner.user_id,
        action: AuditAction.USER_SETUP_UPDATED,
        resource_type: "user",
        resource_id: owner.user_id,
        result: "success",
        before: audited(setupFromRow(before)),
        after: audited(after),
        metadata: { source: "own_setup", fields: Object.keys(patch).sort() },
      },
      tx,
    );
    return after;
  });
}
