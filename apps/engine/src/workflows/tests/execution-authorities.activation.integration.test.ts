import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  sessions,
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
import { executionAuthoritiesFixtures } from "./execution-authorities-fixtures.ts";

let ctx: TestDb;

const { fixture } = executionAuthoritiesFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("authority_grant");
});

afterAll(async () => {
  await ctx.cleanup();
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

test("activating a saved change keeps the approval when its boundary does not grow", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const { valid_until: _until, max_runs: _runs, ...openEnded } = f.input;
  const granted = await grantWorkflowAuthority(
    f.workflow.id,
    { ...openEnded, activation: { expected_current_version_id: null } },
    f.context,
  );
  const [draft] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: {
        name: f.workflow.slug,
        steps: [
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: "https://example.test/messages",
            body: { recipient: "another@example.test" },
          },
        ],
      },
    })
    .returning();
  if (!draft) throw new Error("missing draft fixture");
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: draft.id })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const reviewed = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: draft.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  await activateWorkflowDraft(
    f.workflow.id,
    {
      workflow_version_id: draft.id,
      expected_current_version_id: f.version.id,
      expected_manifest_digest: reviewed.digest,
      execution_environment: "dev",
    },
    f.context,
  );
  const rows = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id));
  const child = rows.find((row) => row.inherited_from === granted.id);
  expect(child).toMatchObject({
    workflow_version_id: draft.id,
    effect_manifest_digest: reviewed.digest,
    max_runs: null,
    valid_until: null,
  });
  expect(rows.find((row) => row.id === granted.id)?.superseded_by).toBe(child?.id ?? "missing");
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

test("a saved change older than the active version cannot be activated over it", async () => {
  const f = await fixture();
  const versionRow = (version: number, recipient: string) => ({
    tenant_id: f.workflow.tenant_id,
    workflow_id: f.workflow.id,
    version,
    dag: {
      name: f.workflow.slug,
      steps: [
        {
          id: "send",
          kind: "request",
          method: "POST",
          url: "https://example.test/messages",
          body: { recipient },
        },
      ],
    },
  });
  const [draft] = await ctx.db
    .insert(workflowVersions)
    .values(versionRow(2, "draft@example.test"))
    .returning();
  const [newer] = await ctx.db
    .insert(workflowVersions)
    .values(versionRow(3, "newer@example.test"))
    .returning();
  if (!draft || !newer) throw new Error("missing version fixture");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: newer.id, draft_version_id: draft.id, lifecycle: "active" })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  const reviewed = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: draft.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  await expect(
    activateWorkflowDraft(
      f.workflow.id,
      {
        workflow_version_id: draft.id,
        expected_current_version_id: newer.id,
        expected_manifest_digest: reviewed.digest,
        execution_environment: "dev",
      },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_activation_changed" });
  const { valid_until: _until, max_runs: _runs, ...openEnded } = f.input;
  await expect(
    grantWorkflowAuthority(
      f.workflow.id,
      {
        ...openEnded,
        workflow_version_id: draft.id,
        expected_manifest_digest: reviewed.digest,
        activation: { expected_current_version_id: newer.id },
      },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "authority_activation_changed" });
  const [workflow] = await ctx.db
    .select()
    .from(workflows)
    .where(eq(workflows.tenant_id, f.workflow.tenant_id));
  expect(workflow?.current_version_id).toBe(newer.id);
  expect(workflow?.draft_version_id).toBe(draft.id);
  const grants = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.tenant_id, f.workflow.tenant_id));
  expect(grants).toHaveLength(0);
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
