import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflows } from "../../db/schema/index.ts";
import { grantResource } from "../../rbac/index.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  createWorkflow,
  ctx,
  headers,
  invocation,
  reader,
  setupWorkflowInvocation,
} from "./workflow-invocation-fixtures.ts";

setupWorkflowInvocation();

describe("workflow start access", () => {
  test("reports the authenticated caller permission independently from effect approvals", async () => {
    const wf = await createWorkflow();
    const { body } = await invocation(wf.id);
    expect(body.start_access.caller.allowed).toBe(true);
    expect(body.start_access.permission).toBe("workflow:run");
    expect(body.start_access.rules?.roles.some((role) => role.name === "admin")).toBe(true);
    expect(body.start_access.external).toEqual({
      authentication_required: true,
      credential_restrictions_apply: true,
    });
    expect(body.start_access.without_approval).toBe("held_preview_only");
    expect(body.authority).toEqual({ dev: "held_preview_only", prod: "held_preview_only" });
  });

  test("does not expose permission rules to readers and honors credential scope ceilings", async () => {
    const wf = await createWorkflow();
    const key = await reader(
      "restricted-run",
      ["workflow:read", "workflow:run", "rbac:read"],
      ["workflow:read"],
    );
    const { status, body } = await invocation(wf.id, key);
    expect(status).toBe(200);
    expect(body.start_access.caller).toEqual({
      allowed: false,
      source: "credential_ceiling",
      reason: "credential_ceiling:scope_not_granted",
    });
    expect(body.start_access.visibility.rules).toBe(false);
    expect(body.start_access).not.toHaveProperty("rules");
  });

  test("includes only unexpired start grants for this workflow and this tenant", async () => {
    const wf = await createWorkflow();
    const other = await createWorkflow();
    const subject = "10000000-0000-4000-8000-000000000001";
    const expiredSubject = "10000000-0000-4000-8000-000000000002";
    const otherSubject = "10000000-0000-4000-8000-000000000003";
    const base = {
      tenant_id: ctx.tenantId,
      subject_type: "user" as const,
      resource_type: "workflow",
      permission: "workflow:run",
    };
    await grantResource(ctx.db, { ...base, subject_id: subject, resource_id: wf.id });
    await grantResource(ctx.db, {
      ...base,
      subject_id: expiredSubject,
      resource_id: wf.id,
      expires_at: new Date("2000-01-01T00:00:00Z"),
    });
    await grantResource(ctx.db, { ...base, subject_id: otherSubject, resource_id: other.id });
    const foreignTenant = await seedTenant(ctx.db, {
      slug: "invocation-foreign-rules",
      display_name: "Foreign",
    });
    await grantResource(ctx.db, {
      ...base,
      tenant_id: foreignTenant.id,
      subject_id: otherSubject,
      resource_id: wf.id,
    });
    const { body } = await invocation(wf.id);
    expect(body.start_access.rules?.grants).toEqual([
      { subject_type: "user", subject_id: subject, expires_at: null },
    ]);
  });
});

describe("workflow operating status list", () => {
  test("filters and counts before paging, preserves lifecycle and reports unreadable facts as unknown", async () => {
    const first = await createWorkflow({ name: "operating-http-a" });
    const archived = await createWorkflow({ name: "operating-http-b" });
    const second = await createWorkflow({ name: "operating-http-c" });
    const archivedLater = await createWorkflow({ name: "operating-http-d" });
    for (const workflow of [archived, archivedLater]) {
      await ctx.db
        .update(workflows)
        .set({ lifecycle: "archived" })
        .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, workflow.id)));
    }
    const query = "q=operating-http-&operating_status=disabled&sort=name&order=asc&limit=1";
    const fetchPage = async (offset: number) => {
      const response = await fetch(`${ctx.baseUrl}/v1/workflows?${query}&offset=${offset}`, {
        headers: headers(),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        total: number;
        items: Array<{ id: string; lifecycle: string; operating_status: string }>;
      };
    };
    const page = await fetchPage(0);
    const next = await fetchPage(1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: archived.id,
      lifecycle: "archived",
      operating_status: "disabled",
    });
    expect(next.total).toBe(2);
    expect(next.items[0]?.id).toBe(archivedLater.id);
    expect((await fetchPage(2)).items).toEqual([]);
    const readerKey = await reader("operating-status-reader", ["workflow:read"]);
    const restricted = await fetch(
      `${ctx.baseUrl}/v1/workflows?q=operating-http-&operating_status=unknown`,
      { headers: headers(readerKey) },
    );
    expect(restricted.status).toBe(200);
    const restrictedBody = (await restricted.json()) as {
      total: number;
      items: Array<{ id: string; operating_status: string }>;
    };
    expect(restrictedBody.total).toBe(2);
    expect(restrictedBody.items.map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(restrictedBody.items.every((item) => item.operating_status === "unknown")).toBe(true);
  });
});
