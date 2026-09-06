import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  auditLog,
  sessions,
  tenants,
  users,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
  revokeWorkflowAuthority,
} from "../execution-authorities.ts";

let ctx: TestDb;
let counter = 0;
beforeAll(async () => {
  ctx = await createTestDb("authority_grant");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture() {
  const slug = `authority-grant-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: tenant.id, email: `${slug}@example.test`, role: "admin" })
    .returning();
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!user || !workflow) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        steps: [
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: "https://example.test/messages",
            body: { recipient: "reviewed@example.test" },
          },
        ],
      },
    })
    .returning();
  const from = await databaseNow(ctx.db);
  const until = new Date(from.getTime() + 60 * 60_000);
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: tenant.id,
      user_id: user.id,
      expires_at: until,
      absolute_expires_at: until,
    })
    .returning();
  if (!version || !session) throw new Error("missing session fixture");
  const payload = { tenant_id: tenant.id, user_id: user.id, session_id: session.id };
  const principal: ResolvedPrincipal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: tenant.id,
    roles: ["admin"],
    session_id: session.id,
  };
  const request = new Request("https://example.test/v1/workflows/authority", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "x-subkit-csrf": await signBrowserCsrf(payload),
    },
  });
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  const input = {
    workflow_version_id: version.id,
    expected_manifest_digest: preview.digest,
    execution_environment: "dev" as const,
    valid_from: from.toISOString(),
    valid_until: until.toISOString(),
    max_runs: 3,
  };
  return { input, context: { db: ctx.db, request, principal }, workflow, session, version };
}

test("a human grants a finite exact boundary without activating or running its draft", async () => {
  const f = await fixture();
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  expect(authority).toMatchObject({
    effect_manifest_digest: f.input.expected_manifest_digest,
    workflow_version_id: f.version.id,
    reserved_runs: 0,
    max_runs: 3,
    target_constraints: { targets: ["https://example.test/messages"] },
    created_by: f.context.principal.id,
  });
  const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, f.workflow.id));
  expect(workflow?.lifecycle).toBe("draft");
  expect(workflow?.current_version_id).toBeNull();
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.workflow.tenant_id), eq(auditLog.resource_id, authority.id)),
    );
  expect(audit.map((row) => row.action)).toEqual(["workflow.authority_granted"]);
});

test("parallel retries return one authority and never multiply the run allowance", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    grantWorkflowAuthority(f.workflow.id, f.input, f.context),
    grantWorkflowAuthority(f.workflow.id, f.input, f.context),
  ]);
  expect(a.id).toBe(b.id);
  const rows = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id));
  expect(rows).toHaveLength(1);
});

test("API-key-style callers and missing or cross-site CSRF proofs cannot grant", async () => {
  const f = await fixture();
  const noSession = { ...f.context.principal };
  delete noSession.session_id;
  await expect(
    grantWorkflowAuthority(f.workflow.id, f.input, { ...f.context, principal: noSession }),
  ).rejects.toMatchObject({ code: "human_session_required" });
  for (const headers of [
    new Headers({ cookie: f.context.request.headers.get("cookie")! }),
    new Headers(f.context.request.headers),
  ]) {
    if (headers.has("x-subkit-csrf")) headers.set("sec-fetch-site", "cross-site");
    await expect(
      grantWorkflowAuthority(f.workflow.id, f.input, {
        ...f.context,
        request: new Request(f.context.request.url, { method: "POST", headers }),
      }),
    ).rejects.toMatchObject({ code: "csrf_rejected" });
  }
});

test("signed but revoked sessions cannot grant", async () => {
  const f = await fixture();
  await ctx.db
    .update(sessions)
    .set({ revoked_at: await databaseNow(ctx.db) })
    .where(eq(sessions.id, f.session.id));
  await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toMatchObject({
    code: "human_session_expired",
  });
});

test("a user without workflow permission cannot grant", async () => {
  const f = await fixture();
  await expect(
    grantWorkflowAuthority(f.workflow.id, f.input, {
      ...f.context,
      principal: { ...f.context.principal, roles: [] },
    }),
  ).rejects.toMatchObject({ code: "authority_permission_denied" });
});

test("stale manifests and invalid finite windows are rejected", async () => {
  const f = await fixture();
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      { ...f.input, expected_manifest_digest: "0".repeat(64) },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_manifest_changed" });
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      { ...f.input, valid_until: f.input.valid_from },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_window_invalid" });
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      {
        ...f.input,
        valid_until: new Date(
          new Date(f.input.valid_from).getTime() + 32 * 24 * 60 * 60_000,
        ).toISOString(),
      },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_window_invalid" });
});

test("revocation is idempotent and an old browser retry cannot resurrect it", async () => {
  const f = await fixture();
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const revoked = await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context);
  expect(revoked.revoked_at).not.toBeNull();
  expect(await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context)).toEqual(revoked);
  await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toMatchObject({
    code: "authority_revoked",
  });
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.workflow.tenant_id), eq(auditLog.resource_id, authority.id)),
    );
  expect(audit.map((row) => row.action).sort()).toEqual([
    "workflow.authority_granted",
    "workflow.authority_revoked",
  ]);
});

test("audit failure rolls the grant back", async () => {
  const f = await fixture();
  await ctx.db.execute(
    sql.raw(`CREATE FUNCTION subkit.reject_authority_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'workflow.authority_granted' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_authority_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.reject_authority_audit()`),
  );
  try {
    await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toThrow();
    expect(
      await ctx.db
        .select()
        .from(workflowExecutionAuthorities)
        .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id)),
    ).toHaveLength(0);
  } finally {
    await ctx.db.execute(
      sql.raw(
        "DROP TRIGGER reject_authority_audit ON subkit.audit_log; DROP FUNCTION subkit.reject_authority_audit()",
      ),
    );
  }
});
