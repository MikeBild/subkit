import {
  DEFAULT_WORKSPACE_LANGUAGE,
  firstLanguage,
  languageOf,
  type WorkspaceLanguage,
} from "@shared/workspace-language.ts";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import {
  apiKeys,
  connectors,
  executions,
  mcpOauthGrants,
  sessions,
  tenants,
  users,
  workflows,
} from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";

export async function updateOwnProfile(
  input: {
    tenant_id: string;
    user_id: string;
    display_name?: string;
    start_steps_hidden?: boolean;
  },
  db: Executor,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(users)
      .where(
        and(
          eq(users.tenant_id, input.tenant_id),
          eq(users.id, input.user_id),
          isNull(users.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!before) return null;
    const timestamp = new Date(now());
    const nameChanged =
      input.display_name !== undefined && input.display_name !== before.display_name;
    const hiddenChanged =
      input.start_steps_hidden !== undefined &&
      input.start_steps_hidden !== (before.start_steps_hidden_at !== null);
    if (!nameChanged && !hiddenChanged) return before;
    const [row] = await tx
      .update(users)
      .set({
        ...(nameChanged ? { display_name: input.display_name } : {}),
        ...(hiddenChanged
          ? { start_steps_hidden_at: input.start_steps_hidden ? timestamp : null }
          : {}),
        updated_at: timestamp,
      })
      .where(and(eq(users.tenant_id, input.tenant_id), eq(users.id, input.user_id)))
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: "user",
        actor_id: input.user_id,
        action: AuditAction.USER_PROFILE_UPDATED,
        resource_type: "user",
        resource_id: row.id,
        result: "success",
        before: {
          display_name: before.display_name,
          start_steps_hidden: before.start_steps_hidden_at !== null,
        },
        after: {
          display_name: row.display_name,
          start_steps_hidden: row.start_steps_hidden_at !== null,
        },
        metadata: { source: "own_profile" },
      },
      tx,
    );
    return row;
  });
}

export async function isWorkspaceOwnerSession(
  input: { tenant_id: string; user_id: string; session_id: string },
  db: Executor,
): Promise<boolean> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(sessions)
    .innerJoin(
      users,
      and(
        eq(users.id, sessions.user_id),
        eq(users.tenant_id, sessions.tenant_id),
        eq(users.auth_identity_id, sessions.auth_identity_id),
      ),
    )
    .innerJoin(
      tenants,
      and(
        eq(tenants.id, sessions.tenant_id),
        eq(tenants.owner_identity_id, users.auth_identity_id),
      ),
    )
    .where(
      and(
        eq(sessions.id, input.session_id),
        eq(sessions.tenant_id, input.tenant_id),
        eq(sessions.user_id, input.user_id),
        isNotNull(sessions.auth_identity_id),
        isNull(sessions.revoked_at),
        isNull(users.deleted_at),
        eq(users.status, "active"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function updateWorkspaceSettings(
  input: {
    tenant_id: string;
    display_name?: string;
    timezone?: string;
    language?: WorkspaceLanguage;
    actor_type: "user" | "system_account";
    actor_id: string;
  },
  db: Executor,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, input.tenant_id), isNull(tenants.deleted_at)))
      .for("update")
      .limit(1);
    if (!before) return null;
    const nameChanged =
      input.display_name !== undefined && input.display_name !== before.display_name;
    const timezoneChanged = input.timezone !== undefined && input.timezone !== before.timezone;
    const languageChanged = input.language !== undefined && input.language !== before.language;
    if (!nameChanged && !timezoneChanged && !languageChanged) return before;
    const [row] = await tx
      .update(tenants)
      .set({
        ...(nameChanged ? { display_name: input.display_name } : {}),
        ...(timezoneChanged ? { timezone: input.timezone } : {}),
        ...(languageChanged ? { language: input.language } : {}),
        updated_at: new Date(now()),
      })
      .where(eq(tenants.id, input.tenant_id))
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_type,
        actor_id: input.actor_id,
        action: AuditAction.TENANT_UPDATED,
        resource_type: "tenant",
        resource_id: row.id,
        result: "success",
        before: {
          display_name: before.display_name,
          timezone: before.timezone,
          language: before.language,
        },
        after: { display_name: row.display_name, timezone: row.timezone, language: row.language },
      },
      tx,
    );
    return row;
  });
}

export async function workspaceLanguage(
  tenant_id: string,
  db: Executor,
): Promise<WorkspaceLanguage> {
  const [row] = await db
    .select({ language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  return row?.language ?? DEFAULT_WORKSPACE_LANGUAGE;
}

export async function languageFor(
  tenant_id: string,
  db: Executor,
  person: unknown,
): Promise<WorkspaceLanguage> {
  return languageOf(person) ?? firstLanguage([await workspaceLanguage(tenant_id, db)]);
}

export interface StartSteps {
  connector: boolean;
  workflow: boolean;
  run: boolean;
  people: boolean;
  client: boolean;
}

export async function readStartSteps(tenant_id: string, db: Executor): Promise<StartSteps> {
  const [connector, workflow, run, people, grant, key] = await Promise.all([
    db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)))
      .limit(1),
    db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)))
      .limit(1),
    db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.tenant_id, tenant_id))
      .limit(1),
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenant_id, tenant_id), isNull(users.deleted_at)))
      .limit(2),
    db
      .select({ id: mcpOauthGrants.id })
      .from(mcpOauthGrants)
      .where(and(eq(mcpOauthGrants.tenant_id, tenant_id), isNull(mcpOauthGrants.revoked_at)))
      .limit(1),
    db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenant_id, tenant_id),
          isNotNull(apiKeys.user_id),
          isNull(apiKeys.revoked_at),
        ),
      )
      .limit(1),
  ]);
  return {
    connector: connector.length > 0,
    workflow: workflow.length > 0,
    run: run.length > 0,
    people: people.length > 1,
    client: grant.length > 0 || key.length > 0,
  };
}
