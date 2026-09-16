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
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { inspectScheduleAutomation } from "../../scheduler/automation-status.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import {
  activateWorkflowDraft,
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

async function fixture(extraDefinition: Record<string, unknown> = {}) {
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
        ...extraDefinition,
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

test("reviewed active authority resolves exactly its held schedule, audited and retry-safe", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const hold = {
    reason_code: "execution_authority_unavailable" as const,
    observed_at: f.input.valid_from,
  };
  const [schedule] = await ctx.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      cron: "0 9 * * *",
      timezone: "UTC",
      execution_mode: "dev",
      admission_hold: hold,
    })
    .returning();
  if (!schedule) throw new Error("missing schedule");
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("approval_required");
  const [other] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: f.workflow.tenant_id,
      slug: "unrelated-hold",
      name: "Other report",
      lifecycle: "draft",
    })
    .returning();
  if (!other) throw new Error("missing unrelated workflow");
  await ctx.db.insert(workflowsSchedules).values({
    tenant_id: f.workflow.tenant_id,
    workflow_id: other.id,
    cron: "0 10 * * *",
    execution_mode: "dev",
    admission_hold: hold,
  });
  const countOpen = async () =>
    (
      await ctx.db
        .select()
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
            sql`${workflowsSchedules.admission_hold} IS NOT NULL`,
          ),
        )
    ).length;
  expect(await countOpen()).toBe(2);
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const read = async () =>
    (
      await ctx.db
        .select()
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
            eq(workflowsSchedules.id, schedule.id),
          ),
        )
    )[0];
  expect((await read())?.admission_hold).toBeNull();
  expect(await countOpen()).toBe(1);
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("authorized");
  await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.workflow.tenant_id),
        eq(auditLog.resource_id, schedule.id),
        eq(auditLog.action, "schedule.admission.changed"),
      ),
    );
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toMatchObject({
    state: "authorized",
    execution_authority_id: authority.id,
  });
  await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context);
  expect((await inspectScheduleAutomation(schedule, ctx.db)).ready).toBe(false);
});

for (const scenario of [
  "inactive",
  "different_environment",
  "future",
  "exhausted",
  "missing_input",
] as const) {
  test(`a ${scenario} authority does not resolve a held schedule`, async () => {
    const f = await fixture(
      scenario === "missing_input"
        ? {
            input_schema: {
              type: "object",
              required: ["report"],
              properties: { report: { type: "string" } },
            },
          }
        : {},
    );
    if (scenario !== "inactive")
      await ctx.db
        .update(workflows)
        .set({ lifecycle: "active", current_version_id: f.version.id })
        .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
    const hold = {
      reason_code: "execution_authority_unavailable" as const,
      observed_at: f.input.valid_from,
    };
    const [schedule] = await ctx.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: f.workflow.tenant_id,
        workflow_id: f.workflow.id,
        cron: "0 9 * * *",
        timezone: "UTC",
        execution_mode: scenario === "different_environment" ? "prod" : "dev",
        admission_hold: hold,
      })
      .returning();
    if (!schedule) throw new Error("missing schedule");
    const input =
      scenario === "future"
        ? {
            ...f.input,
            valid_from: new Date(Date.parse(f.input.valid_from) + 60_000).toISOString(),
          }
        : f.input;
    const authority = await grantWorkflowAuthority(f.workflow.id, input, f.context);
    if (scenario === "exhausted") {
      await ctx.db
        .update(workflowExecutionAuthorities)
        .set({ reserved_runs: authority.max_runs })
        .where(
          and(
            eq(workflowExecutionAuthorities.tenant_id, f.workflow.tenant_id),
            eq(workflowExecutionAuthorities.id, authority.id),
          ),
        );
      await ctx.db
        .update(workflowsSchedules)
        .set({ admission_hold: hold })
        .where(
          and(
            eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
            eq(workflowsSchedules.id, schedule.id),
          ),
        );
      await grantWorkflowAuthority(f.workflow.id, input, f.context);
    }
    const [observed] = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
          eq(workflowsSchedules.id, schedule.id),
        ),
      );
    expect(observed?.admission_hold).toEqual(hold);
    expect((await inspectScheduleAutomation(schedule, ctx.db)).ready).toBe(false);
  });
}

test("automation evidence rejects expired, changed-version and cross-tenant grants", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const [schedule] = await ctx.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      cron: "0 9 * * *",
      timezone: "UTC",
      execution_mode: "dev",
    })
    .returning();
  if (!schedule) throw new Error("missing schedule");
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  const now = Date.parse(f.input.valid_from);
  await ctx.db.insert(workflowExecutionAuthorities).values({
    tenant_id: f.workflow.tenant_id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.version.id,
    effect_manifest_digest: preview.digest,
    effect_manifest: preview.manifest,
    execution_environment: "dev",
    target_constraints: { targets: [] },
    valid_from: new Date(now - 7200000),
    valid_until: new Date(now - 3600000),
    max_runs: 1,
    created_by: f.context.principal.id,
  });
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("approval_required");
  await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  const [v2] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: f.version.dag,
    })
    .returning();
  if (!v2) throw new Error("missing version");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: v2.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("approval_required");
  expect(
    (
      await inspectScheduleAutomation(
        { ...schedule, tenant_id: "00000000-0000-4000-8000-000000000099" },
        ctx.db,
      )
    ).ready,
  ).toBe(false);
});

test("chat review atomically activates its exact draft, clears one hold, and retries without another allowance", async () => {
  const f = await fixture({
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC", execution_mode: "dev" },
  });
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const input = { ...f.input, activation: { expected_current_version_id: null } };
  const granted = await grantWorkflowAuthority(f.workflow.id, input, f.context);
  const [active] = await ctx.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  expect(active).toMatchObject({
    current_version_id: f.version.id,
    draft_version_id: null,
    lifecycle: "active",
  });
  const [schedule] = await ctx.db
    .select()
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, f.workflow.tenant_id),
        eq(workflowsSchedules.workflow_id, f.workflow.id),
      ),
    );
  expect(schedule).toBeDefined();
  if (!schedule) throw new Error("missing bound schedule");
  expect((await inspectScheduleAutomation(schedule, ctx.db)).state).toBe("authorized");
  expect((await grantWorkflowAuthority(f.workflow.id, input, f.context)).id).toBe(granted.id);
  const events = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.workflow.tenant_id), eq(auditLog.resource_id, f.workflow.id)),
    );
  expect(events.filter((row) => row.action === "workflow.updated")).toHaveLength(1);
  expect(granted.reserved_runs).toBe(0);
});

test("changed draft or reviewed base cannot be activated or granted", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      { ...f.input, activation: { expected_current_version_id: f.version.id } },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_activation_changed" });
  const grants = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.tenant_id, f.workflow.tenant_id));
  expect(grants).toHaveLength(0);
  const [workflow] = await ctx.db
    .select()
    .from(workflows)
    .where(eq(workflows.tenant_id, f.workflow.tenant_id));
  expect(workflow?.current_version_id).toBeNull();
});

test("activation remains unchanged when the reviewed effect digest is stale", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      {
        ...f.input,
        expected_manifest_digest: "0".repeat(64),
        activation: { expected_current_version_id: null },
      },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_manifest_changed" });
  const [workflow] = await ctx.db
    .select()
    .from(workflows)
    .where(eq(workflows.tenant_id, f.workflow.tenant_id));
  expect(workflow?.current_version_id).toBeNull();
  expect(workflow?.draft_version_id).toBe(f.version.id);
});

test("variable-effect draft can be activated for concrete review without granting automatic runs", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const dynamic = structuredClone(f.version.dag) as Record<string, unknown>;
  dynamic.steps = [
    {
      id: "send",
      kind: "request",
      method: "POST",
      url: "https://example.test/messages",
      body: { content: "${input.content}" },
    },
  ];
  await ctx.db
    .update(workflowVersions)
    .set({ dag: dynamic })
    .where(eq(workflowVersions.id, f.version.id));
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  expect(preview.eligible_for_repeated_runs).toBe(false);
  f.input.expected_manifest_digest = preview.digest;
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      { ...f.input, activation: { expected_current_version_id: null } },
      f.context,
    ),
  ).rejects.toThrow();
  const result = await activateWorkflowDraft(
    f.workflow.id,
    {
      workflow_version_id: f.version.id,
      expected_current_version_id: null,
      expected_manifest_digest: f.input.expected_manifest_digest,
      execution_environment: "dev",
    },
    f.context,
  );
  expect(result).toMatchObject({ activated: true, execution_authorized: false });
  expect(
    await ctx.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.tenant_id, f.workflow.tenant_id)),
  ).toHaveLength(0);
});

test("activation rejects callers without a human browser session", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  await expect(
    activateWorkflowDraft(
      f.workflow.id,
      {
        workflow_version_id: f.version.id,
        expected_current_version_id: null,
        expected_manifest_digest: f.input.expected_manifest_digest,
        execution_environment: "dev",
      },
      { ...f.context, request: new Request("https://example.test/activate", { method: "POST" }) },
    ),
  ).rejects.toMatchObject({ code: "human_session_required" });
});

test("an actively used browser session can approve after its original sliding deadline", async () => {
  const f = await fixture();
  const now = await databaseNow(ctx.db);
  await ctx.db
    .update(sessions)
    .set({
      expires_at: new Date(now.getTime() - 60_000),
      absolute_expires_at: new Date(now.getTime() + 60 * 60_000),
      last_seen_at: now,
    })
    .where(eq(sessions.id, f.session.id));
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  expect(authority.workflow_version_id).toBe(f.version.id);
  await revokeWorkflowAuthority(f.workflow.id, authority.id, f.context);
});

for (const expired of ["absolute", "idle"] as const) {
  test(`a signed session past its ${expired} deadline cannot approve`, async () => {
    const f = await fixture();
    const now = await databaseNow(ctx.db);
    await ctx.db
      .update(sessions)
      .set({
        expires_at: new Date(now.getTime() + 60 * 60_000),
        absolute_expires_at: new Date(
          now.getTime() + (expired === "absolute" ? -60_000 : 60 * 60_000),
        ),
        last_seen_at: new Date(now.getTime() - (expired === "idle" ? 9 * 60 * 60_000 : 0)),
      })
      .where(eq(sessions.id, f.session.id));
    await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toMatchObject({
      code: "human_session_expired",
    });
    expect(
      await ctx.db
        .select()
        .from(workflowExecutionAuthorities)
        .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id)),
    ).toHaveLength(0);
  });
}
