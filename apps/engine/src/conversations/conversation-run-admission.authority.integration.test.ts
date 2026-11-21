import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  conversationElicitations,
  conversationToolCalls,
  toolApprovals,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { capturePreparedWorkflowBinding } from "../tools/prepared-workflow-approval.ts";
import {
  actorId,
  fixture,
  remote,
  tdb,
  useConversationRunAdmissionSetup,
} from "./conversation-run-admission-fixtures.ts";
import { decideToolMode } from "./tool-policies.ts";

useConversationRunAdmissionSetup();

test("activation after a held preview invalidates the chat approval without dispatch", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  const [version] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: { ...f.definition, description: "Unreviewed replacement" },
    })
    .returning();
  if (!version) throw new Error("missing replacement version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.error_code).toBe("prepared_workflow_changed");
  expect(remote.callCount()).toBe(before);
  expect(await f.rows()).toHaveLength(1);
  const denied = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.reason, "prepared_workflow_changed")),
    );
  expect(denied).toHaveLength(1);
});

test("an earlier-format or unreadable held approval cannot inherit the latest version", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  await tdb.db
    .update(toolApprovals)
    .set({ preview_ciphertext: null, preview_iv: null, preview_auth_tag: null })
    .where(eq(toolApprovals.tenant_id, f.tenant.id));
  const before = remote.callCount();
  expect((await f.confirmPrepared()).synthetic_result?.error_code).toBe(
    "prepared_workflow_changed",
  );
  expect(remote.callCount()).toBe(before);
});

test("prepared provenance rejects different tenant, input, environment and live runs", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  const [run] = await f.rows();
  if (!run) throw new Error("missing preparation");
  const params = {
    db: tdb.db,
    tenant_id: f.tenant.id,
    execution_id: run.id,
    tool: `wf_${f.workflow.slug}`,
    execution_mode: "dev" as const,
    args: {},
  };
  expect((await capturePreparedWorkflowBinding(params)).workflow_version_id).toBe(f.version.id);
  const other = await fixture();
  for (const changed of [
    { tenant_id: other.tenant.id },
    { args: { recipient: "other" } },
    { execution_mode: "prod" as const },
    { tool: `wf_${other.workflow.slug}` },
  ]) {
    await expect(capturePreparedWorkflowBinding({ ...params, ...changed })).rejects.toThrow();
  }
  const live = await fixture({ maxRuns: 1 });
  await live.runTool("synthetic");
  const [liveRun] = await live.rows();
  if (!liveRun) throw new Error("missing live run");
  await expect(
    capturePreparedWorkflowBinding({
      ...params,
      tenant_id: live.tenant.id,
      execution_id: liveRun.id,
      tool: `wf_${live.workflow.slug}`,
    }),
  ).rejects.toThrow();
});

for (const kind of ["generic", "synthetic"] as const) {
  test(`${kind} workflow tool cannot use an expired local authority`, async () => {
    const f = await fixture({ maxRuns: 1, expired: true });
    const before = remote.callCount();
    await f.runTool(kind);
    expect(remote.callCount()).toBe(before);
    expect(await f.reserved()).toBe(0);
    expect((await f.rows())[0]).toMatchObject({
      hold_writes: true,
      execution_authority_id: null,
      workflow_version_id: f.version.id,
    });
  });

  test(`${kind} workflow tool automatically reserves a matching local authority`, async () => {
    const f = await fixture({ maxRuns: 2 });
    const before = remote.callCount();
    for (let index = 0; index < 2; index++) {
      const result = await f.runTool(kind);
      expect(result).toMatchObject({ ok: true });
    }
    expect(remote.callCount() - before).toBe(2);
    expect(await f.reserved()).toBe(2);
    expect((await f.rows()).every((row) => row.execution_authority_id === f.authority?.id)).toBe(
      true,
    );
    const decisions = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, f.tenant.id));
    expect(decisions).toHaveLength(0);
    if (kind === "synthetic") {
      const audit = await tdb.db.select().from(auditLog).where(eq(auditLog.tenant_id, f.tenant.id));
      const runs = audit.filter(
        (row) =>
          row.metadata !== null &&
          typeof row.metadata === "object" &&
          "via_action" in row.metadata &&
          row.metadata.via_action === "conversation.run_workflow",
      );
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        expect(run.metadata).toMatchObject({
          workflow_version_id: f.version.id,
          execution_authority_id: f.authority?.id,
          hold_writes: false,
          writes_held: false,
        });
      }
    }
  });
}

test("production tool policy admits an existing local grant without a second gate", async () => {
  const f = await fixture({ maxRuns: 1, environment: "prod" });
  expect(
    decideToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow: f.workflow.id, environment: "prod" },
      overrides: {},
    }).mode,
  ).toBe("no_confirm");
  const before = remote.callCount();
  await f.runTool("generic");
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  expect((await f.rows())[0]).toMatchObject({
    execution_mode: "prod",
    execution_authority_id: f.authority?.id,
  });
});

test("an ordinary production tool start without authority remains held", async () => {
  const f = await fixture({ environment: "prod" });
  const before = remote.callCount();
  await f.runTool("generic");
  expect(remote.callCount()).toBe(before);
  expect((await f.rows())[0]).toMatchObject({
    execution_mode: "prod",
    hold_writes: true,
    execution_authority_id: null,
  });
});

test("synthetic tools that ask before writing run a start that a standing grant covers without a question", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  const result = await f.runTool("synthetic", undefined, { askBeforeWriting: true });
  expect(result).toMatchObject({ ok: true });
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  expect((await f.rows())[0]).toMatchObject({
    hold_writes: false,
    execution_authority_id: f.authority?.id,
  });
  const pending = await tdb.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.tenant_id, f.tenant.id));
  expect(pending).toHaveLength(0);
});

test("synthetic tools preserve an explicit per-workflow approval preference", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await f.runTool("synthetic", undefined, {
    toolPolicies: { [`wf_${f.workflow.slug}`]: "confirm_before_execution" },
  });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.hold_writes).toBe(true);
});

async function retryCatalogConflict<T>(operation: () => Promise<T>): Promise<T> {
  let result = await operation();
  const busy = () =>
    JSON.stringify(result)?.includes(
      "Catalog vocabulary changed concurrently; retry the operation",
    ) === true;
  await waitFor(
    async () => {
      if (!busy()) return true;
      result = await operation();
      return !busy();
    },
    { tries: 40, sleepMs: 5, label: "catalog conflict retried before admission" },
  );
  return result;
}

test("generic, synthetic and fast-path starts share the last-run reservation after catalog conflict retries", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await Promise.all([
    retryCatalogConflict(() => f.runTool("generic")),
    retryCatalogConflict(() => f.runTool("synthetic")),
    retryCatalogConflict(() => f.run()),
  ]);
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const rows = await f.rows();
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.execution_authority_id === f.authority?.id)).toHaveLength(1);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(2);
});

test("generic workflow tool preserves an explicit preparation despite an available grant", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await f.runTool("generic", false);
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.hold_writes).toBe(true);
});

for (const surface of ["chat", "mcp"] as const) {
  test(`${surface}: unapproved writes are durably held, including an author-supplied read label`, async () => {
    const f = await fixture({ readLabel: true });
    const before = remote.callCount();
    const result = await f.run(surface);
    expect(result?.status).toBe("active");
    expect(result?.assistant_text).toContain("Nothing was written");
    expect(remote.callCount()).toBe(before);
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hold_writes: true,
      workflow_version_id: f.version.id,
      execution_authority_id: null,
    });
    const event = result?.events.find((entry) => entry.type === "tool_result");
    if (event?.type !== "tool_result") throw new Error("missing result");
    expect(event.output).toMatchObject({ ok: false, writes_held: true, preview: true });
    expect(await f.activity()).toEqual([{ outcome: "ok", approval_required: false }]);
  });
}

test("a German start explains the held preparation in German", async () => {
  const f = await fixture();
  const before = remote.callCount();
  const result = await f.run("chat", "starte");
  expect(result?.assistant_text).toContain("Es wurde nichts geschrieben");
  expect(result?.assistant_text).toContain("Ausführungsfreigabe");
  expect(result?.assistant_text).not.toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
});

test("matching authority runs twice without a new gate, then holds the exhausted third run", async () => {
  const f = await fixture({ maxRuns: 2 });
  const before = remote.callCount();
  for (const surface of ["chat", "mcp"] as const) {
    const result = await f.run(surface);
    expect(result?.status).toBe("active");
    expect(result?.assistant_text).not.toContain("Nothing was written");
  }
  expect(remote.callCount() - before).toBe(2);
  expect(await f.reserved()).toBe(2);
  const third = await f.run();
  expect(third?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount() - before).toBe(2);
  const rows = await f.rows();
  expect(rows.filter((row) => row.execution_authority_id === f.authority?.id)).toHaveLength(2);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(1);
});

test("parallel starts cannot spend the last authorized run twice after catalog conflict retries", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await Promise.all([
    retryCatalogConflict(() => f.run("chat")),
    retryCatalogConflict(() => f.run("mcp")),
  ]);
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(1);
});

test("expired authority cannot release a write", async () => {
  const f = await fixture({ maxRuns: 1, expired: true });
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("revoked authority cannot release a write", async () => {
  const f = await fixture({ maxRuns: 1 });
  if (!f.authority) throw new Error("missing authority");
  await tdb.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: await databaseNow(tdb.db), revoked_by: actorId })
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, f.tenant.id),
        eq(workflowExecutionAuthorities.id, f.authority.id),
      ),
    );
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("a newer workflow version cannot inherit the old authority", async () => {
  const f = await fixture({ maxRuns: 1 });
  const [next] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: { ...f.definition, description: "New revision requires its own decision" },
    })
    .returning();
  if (!next) throw new Error("missing next version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: next.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.workflow_version_id).toBe(next.id);
});

test("a submitted input form cannot authorize writes through execute_writes=true", async () => {
  const f = await fixture();
  const before = remote.callCount();
  const result = await f.submitInput(true);
  expect(result.dispatched).toBe(true);
  expect(result.synthetic_result?.ok).toBe(false);
  expect(result.synthetic_result?.data).toMatchObject({
    preview: true,
    writes_held: true,
    execute_writes: false,
  });
  expect(remote.callCount()).toBe(before);
  expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
  expect(await f.activity()).toEqual([{ outcome: "ok", approval_required: false }]);
  const approvalEvents = await tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "approval.approved")));
  expect(approvalEvents).toHaveLength(0);
  const resumedEvents = await tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "conversation.resumed")));
  expect(resumedEvents).toHaveLength(1);
  expect(resumedEvents[0]).toMatchObject({
    result: "success",
    reason: "workflow_input_submitted",
    metadata: { ok: false, preparation: true },
  });
  const calls = await tdb.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.tenant_id, f.tenant.id));
  expect(calls[0]?.confirmation_state).toBeNull();
});

test("submitted input uses an existing local authority without another decision", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  const result = await f.submitInput(true);
  expect(result.synthetic_result?.ok).toBe(true);
  expect(result.synthetic_result?.data).toMatchObject({
    execution_authority_id: f.authority?.id,
    execute_writes: true,
  });
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
});

test("an explicit preparation form does not spend an available live run", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  const result = await f.submitInput(false);
  expect(result.synthetic_result?.data).toMatchObject({ preview: true, writes_held: true });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("a generated missing-input form preserves an explicit preparation request", async () => {
  const f = await fixture({ maxRuns: 1, inputRequired: true });
  const before = remote.callCount();
  await f.runTool("generic", false);
  expect(await f.rows()).toHaveLength(0);
  const result = await f.submitGeneratedInput();
  expect(result.synthetic_result?.data).toMatchObject({ preview: true, writes_held: true });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
});

test("a generated missing-input form keeps ordinary local authority discovery", async () => {
  const f = await fixture({ maxRuns: 1, inputRequired: true });
  const before = remote.callCount();
  await f.runTool("generic");
  expect(await f.rows()).toHaveLength(0);
  const result = await f.submitGeneratedInput();
  expect(result.synthetic_result?.data).toMatchObject({
    execution_authority_id: f.authority?.id,
    execute_writes: true,
  });
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const audit = await tdb.db.select().from(auditLog).where(eq(auditLog.tenant_id, f.tenant.id));
  expect(audit.filter((row) => row.action.startsWith("approval."))).toHaveLength(0);
  expect(audit.filter((row) => row.reason === "workflow_input_requested")).toHaveLength(1);
  expect(audit.filter((row) => row.reason === "workflow_input_resolved")).toHaveLength(1);
});
