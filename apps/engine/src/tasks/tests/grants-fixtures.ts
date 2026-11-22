import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  auditLog,
  permissions,
  rolePermissions,
  roles,
  sessions,
  tasks,
  tenants,
  users,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import type { TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewTaskGrant } from "../grants.ts";

export const FINGERPRINT_A = "a".repeat(64);
export const FINGERPRINT_B = "b".repeat(64);

const SEND_STEP = {
  id: "send",
  kind: "request",
  method: "POST",
  url: "https://example.test/messages",
  body: { recipient: "reviewed@example.test" },
};

export const UNBOUND_STEP = {
  id: "send",
  kind: "request",
  method: "POST",
  url: "{{ $input.url }}",
  body: { recipient: "{{ $input.recipient }}" },
};

export function taskGrantFixtures(state: { readonly ctx: TestDb }) {
  let counter = 0;

  async function person(tenant_id: string, role: "admin" | "member" | string[]) {
    const db = state.ctx.db;
    const label = `person-${++counter}`;
    let role_id: string;
    let role_name: string;
    if (Array.isArray(role)) {
      role_name = `role-${counter}`;
      const [custom] = await db.insert(roles).values({ tenant_id, name: role_name }).returning();
      if (!custom) throw new Error("missing role fixture");
      role_id = custom.id;
      for (const name of role) {
        // tenant-filter:exempt — the permission catalog is global
        const [permission] = await db
          .select({ id: permissions.id })
          .from(permissions)
          .where(eq(permissions.name, name))
          .limit(1);
        if (!permission) throw new Error(`missing permission ${name}`);
        await db.insert(rolePermissions).values({ role_id, permission_id: permission.id });
      }
    } else {
      role_name = role;
      role_id = await builtinRoleId(db, role);
    }
    const [user] = await db
      .insert(users)
      .values({ tenant_id, email: `${label}@example.test`, role_id })
      .returning();
    if (!user) throw new Error("missing user fixture");
    const now = await databaseNow(db);
    const until = new Date(now.getTime() + 60 * 60_000);
    const [session] = await db
      .insert(sessions)
      .values({ tenant_id, user_id: user.id, expires_at: until, absolute_expires_at: until })
      .returning();
    if (!session) throw new Error("missing session fixture");
    const payload = { tenant_id, user_id: user.id, session_id: session.id };
    const principal: ResolvedPrincipal = {
      provider: "session",
      kind: "user",
      id: user.id,
      tenant_id,
      roles: [role_name],
      session_id: session.id,
    };
    const cookie = browserSessionCookie(await signBrowserSession(payload));
    const csrf = await signBrowserCsrf(payload);
    const request = new Request("https://example.test/v1/tasks/grants", {
      method: "POST",
      headers: { cookie, "x-subkit-csrf": csrf },
    });
    return { user, session, principal, cookie, csrf, context: { db, request, principal } };
  }

  async function workflow(
    tenant_id: string,
    options: {
      step?: Record<string, unknown>;
      lifecycle?: "active" | "draft";
      extra?: object;
    } = {},
  ) {
    const db = state.ctx.db;
    const slug = `task-grant-wf-${++counter}`;
    const [row] = await db
      .insert(workflows)
      .values({ tenant_id, slug, name: slug, lifecycle: "draft" })
      .returning();
    if (!row) throw new Error("missing workflow fixture");
    const [version] = await db
      .insert(workflowVersions)
      .values({
        tenant_id,
        workflow_id: row.id,
        version: 1,
        dag: { ...options.extra, name: slug, steps: [options.step ?? SEND_STEP] },
      })
      .returning();
    if (!version) throw new Error("missing version fixture");
    if ((options.lifecycle ?? "active") === "active")
      await db
        .update(workflows)
        .set({ lifecycle: "active", current_version_id: version.id })
        .where(eq(workflows.id, row.id));
    return { id: row.id, version_id: version.id };
  }

  async function task(
    tenant_id: string,
    owner_id: string,
    workflow_ids: string[],
    options: {
      environment?: "dev" | "prod";
      fingerprint?: string;
      connector_ids?: string[];
    } = {},
  ) {
    const [row] = await state.ctx.db
      .insert(tasks)
      .values({
        locale: "de",
        tenant_id,
        name: `task-${++counter}`,
        owner_id,
        goal: "goal",
        done_when: "done",
        plan: {},
        bindings: {
          workflow_ids,
          connector_ids: options.connector_ids ?? [],
          skill_slugs: [],
          web_search: false,
        },
        environment: options.environment ?? "dev",
        schedule_cron: "0 9 * * *",
        schedule_timezone: "UTC",
        fingerprint: options.fingerprint ?? FINGERPRINT_A,
        description_source: "human",
        category_source: "human",
      })
      .returning();
    if (!row) throw new Error("missing task fixture");
    return row;
  }

  async function tenant() {
    const slug = `task-grants-${++counter}`;
    const [row] = await state.ctx.db
      .insert(tenants)
      .values({ slug, display_name: slug })
      .returning();
    if (!row) throw new Error("missing tenant fixture");
    return row;
  }

  async function reviewed(
    task_id: string,
    viewer: { context: { db: TestDb["db"]; principal: ResolvedPrincipal } },
    limits: { valid_until?: string | null; max_runs?: number | null } = {},
  ) {
    const preview = await previewTaskGrant(task_id, viewer.context);
    return {
      expected_fingerprint: preview.fingerprint,
      valid_until: limits.valid_until ?? null,
      max_runs: limits.max_runs ?? null,
      expected_workflow_digests: Object.fromEntries(
        preview.workflows.flatMap((item) =>
          item.effect_manifest_digest ? [[item.workflow_id, item.effect_manifest_digest]] : [],
        ),
      ),
    };
  }

  function authorities(tenant_id: string) {
    return state.ctx.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.tenant_id, tenant_id));
  }

  function audits(tenant_id: string, action: string) {
    return state.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, action)));
  }

  return { tenant, person, workflow, task, reviewed, authorities, audits };
}

export async function failureCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code ?? (error as Error).message;
  }
  return "resolved";
}
