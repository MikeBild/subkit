import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  executions,
  intakeItems,
  tenants,
  workflows,
} from "../db/schema/index.ts";
import { boundForPersistence } from "../tools/truncate.ts";
import { PlaybookConflictError, readPlaybook, updatePlaybook } from "./playbook.ts";
import {
  actorId,
  call,
  connector,
  fixture,
  nextSequence,
  plan,
  principal,
  scope,
  step,
  tenantId,
  timestamp,
  usePlaybookSetup,
} from "./playbook-fixtures.ts";

usePlaybookSetup();

describe("persisted playbook evidence and lifecycle", () => {
  test("stores a delivered assessment without claiming technical completion and audits once", async () => {
    const context = await scope();
    const request = {
      expected_revision: 0,
      plan: plan([
        step({
          kind: "assessment",
          description: "Entscheidungsvorlage",
          result: "Die Vorlage nennt Herkunft, offenen Prüfschritt und zuständige Person.",
        }),
      ]),
    };
    const view = await updatePlaybook(fixture.db, context, request);
    expect(view?.status).toBe("in_progress");
    expect(view?.steps[0]?.status).toBe("assessment_ready");
    expect(view?.completion.status).toBe("open");
    expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
    await updatePlaybook(fixture.db, context, request);
    const rows = await fixture.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, context.conversation_id)),
      );
    expect(rows.filter((row) => row.reason === "playbook_updated")).toHaveLength(1);
  });

  test("binds an inspected execution as fresh evidence for that exact run", async () => {
    const context = await scope();
    const [workflow] = await fixture.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: `inspect-run-${nextSequence()}`,
        name: "Inspected run",
        lifecycle: "active",
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .returning();
    if (!workflow) throw new Error("missing workflow");
    const [run] = await fixture.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        status: "failed",
        request_source: "chat",
        execution_mode: "dev",
        started_at: timestamp(100),
        finished_at: timestamp(200),
        created_at: timestamp(100),
      })
      .returning();
    if (!run) throw new Error("missing execution");
    const evidenceId = await call(context, "inspect_execution", {
      inspected: { execution_id: run.id },
      execution: { execution_id: run.id, status: "failed" },
    });
    const view = await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        step({ kind: "resource_observed", resource: { type: "execution", id: run.id } }),
      ]),
    });
    expect(view?.steps[0]?.evidence.map(({ id, label, href }) => ({ id, label, href }))).toEqual([
      { id: evidenceId, label: "Ausführung gelesen", href: `/cockpit/?run=${run.id}` },
    ]);
    expect(view?.steps[0]?.status).toBe("verified");
  });

  test("binds an inspected execution whose stored output was bounded", async () => {
    const context = await scope();
    const [workflow] = await fixture.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: `inspect-bounded-${nextSequence()}`,
        name: "Bounded run",
        lifecycle: "active",
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .returning();
    if (!workflow) throw new Error("missing workflow");
    const [run] = await fixture.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        status: "failed",
        request_source: "chat",
        execution_mode: "dev",
        started_at: timestamp(100),
        finished_at: timestamp(200),
        created_at: timestamp(100),
      })
      .returning();
    if (!run) throw new Error("missing execution");
    const evidenceId = await call(
      context,
      "inspect_execution",
      boundForPersistence(
        {
          inspected: { execution_id: run.id },
          execution: {
            execution_id: run.id,
            status: "failed",
            steps: [{ id: "request", output: "x".repeat(300_000) }],
          },
        },
        "raw_bounded",
      ),
    );
    const view = await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        step({ kind: "resource_observed", resource: { type: "execution", id: run.id } }),
      ]),
    });
    expect(view?.steps[0]?.evidence.map(({ id }) => id)).toEqual([evidenceId]);
    expect(view?.steps[0]?.status).toBe("verified");
  });

  test("binds an exact successful read, rejects foreign and failed calls, and retries auto-binding idempotently", async () => {
    const context = await scope();
    const other = await scope();
    const resource = await connector();
    const criterion = {
      kind: "resource_observed" as const,
      resource: { type: "connector" as const, id: resource.id },
    };
    const foreignId = await call(other, "get_connector", { connector: { id: resource.id } });
    await expect(
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([step(criterion, [foreignId])]),
      }),
    ).rejects.toThrow("playbook_evidence_not_available");
    const failed = await call(
      context,
      "get_connector",
      { connector: { id: resource.id } },
      "error",
    );
    await expect(
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([step(criterion, [failed])]),
      }),
    ).rejects.toThrow("playbook_evidence_not_available");
    const unrelated = await call(context, "search_knowledge", { connector: { id: resource.id } });
    await expect(
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([step(criterion, [unrelated])]),
      }),
    ).rejects.toThrow("playbook_evidence_not_available");
    const actual = await call(context, "get_connector", { connector: { id: resource.id } });
    const request = { expected_revision: 0, plan: plan([step(criterion)]) };
    const view = await updatePlaybook(fixture.db, context, request);
    expect(view?.steps[0]?.evidence[0]?.id).toBe(actual);
    expect(view?.steps[0]?.status).toBe("verified");
    expect(view?.completion.status).toBe("open");
    expect((await updatePlaybook(fixture.db, context, request))?.revision).toBe(1);
    await fixture.db
      .update(connectors)
      .set({ updated_at: timestamp(2000) })
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, resource.id)));
    expect((await readPlaybook(fixture.db, context))?.steps[0]?.status).toBe("stale");
    const restricted = { ...context, principal: { ...principal, scopes: ["conversation:read"] } };
    const denied = await readPlaybook(fixture.db, restricted);
    expect(denied?.status).toBe("blocked");
    expect(denied?.steps[0]?.evidence).toEqual([]);
    expect(denied?.steps[0]?.next_action).toBeNull();
    expect(await readPlaybook(fixture.db, { ...context, tenant_id: actorId })).toBeNull();
    const [otherTenant] = await fixture.db
      .insert(tenants)
      .values({ slug: "other-playbook", display_name: "Other tenant" })
      .returning();
    if (!otherTenant) throw new Error("missing tenant");
    const foreignScope = {
      ...context,
      tenant_id: otherTenant.id,
      principal: { ...principal, tenant_id: otherTenant.id },
    };
    expect(await readPlaybook(fixture.db, foreignScope)).toBeNull();
    await expect(
      updatePlaybook(fixture.db, foreignScope, { expected_revision: 0, plan: request.plan }),
    ).rejects.toThrow("conversation_not_found");
  });

  test("requires intake read rights even when knowledge read remains granted", async () => {
    const context = await scope();
    const [item] = await fixture.db
      .insert(intakeItems)
      .values({
        tenant_id: tenantId,
        category: "tests",
        client_request_id: actorId,
        creation_request_digest: "fixture",
        title: "Private clip",
        body: "Untrusted instructions cannot grant authority",
        original_snapshot: {
          origin: "capture",
          title: "Private clip",
          body: "data",
          captured_at: timestamp().toISOString(),
          source_url: "https://example.invalid",
        },
        collected_by_type: "user",
        collected_by_id: actorId,
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .returning();
    if (!item) throw new Error("missing item");
    const evidenceId = await call(context, "get_intake_item", { item: { id: item.id } });
    await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        step({ kind: "resource_observed", resource: { type: "intake", id: item.id } }, [
          evidenceId,
        ]),
      ]),
    });
    const authorizedView = await readPlaybook(fixture.db, context);
    expect(authorizedView?.steps[0]?.evidence[0]?.href).toBe(
      `/cockpit/intake/${encodeURIComponent(item.id)}`,
    );
    const view = await readPlaybook(fixture.db, {
      ...context,
      principal: { ...principal, scopes: ["conversation:read", "knowledge:read"] },
    });
    expect(view?.status).toBe("blocked");
    expect(view?.steps[0]?.evidence).toEqual([]);
  });

  test("serializes competing revisions and keeps off conversations inert", async () => {
    const context = await scope();
    const base = plan([step({ kind: "assessment", description: "Prüfung", result: null })]);
    const results = await Promise.allSettled([
      updatePlaybook(fixture.db, context, { expected_revision: 0, plan: base }),
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: { ...base, title: "Andere Prüfung" },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason instanceof PlaybookConflictError).toBe(
      true,
    );
    const disabled = await scope("off");
    await expect(
      updatePlaybook(fixture.db, disabled, { expected_revision: 0, plan: base }),
    ).rejects.toThrow("playbooks_disabled");
    expect(await readPlaybook(fixture.db, disabled)).toBeNull();
  });
});
