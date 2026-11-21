import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executionSteps,
  executions,
  toolApprovals,
  vaultItems,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { capturePreparedWorkflowReferences } from "../execution/prepared-workflow-references.ts";
import { assertToolApprovalDispatch } from "../execution/tool-approval-dispatch.ts";
import type { RequestAuthoritySnapshot } from "../execution/types.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { jsonResponse } from "../test-helpers/mock-http.ts";
import { capturePreparedWorkflowBinding } from "../tools/prepared-workflow-approval.ts";
import { authorityConnectorDigest } from "../workflows/authority-configuration.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import {
  actorId,
  fixture,
  remote,
  tdb,
  useConversationRunAdmissionSetup,
} from "./conversation-run-admission-fixtures.ts";

useConversationRunAdmissionSetup();

for (const maxRuns of [undefined, 1]) {
  test(`generic explicit live-run flag ${maxRuns ? "uses local authority once" : "cannot bypass authority"}`, async () => {
    const f = await fixture(maxRuns === undefined ? {} : { maxRuns });
    const before = remote.callCount();
    await f.runTool("generic", true);
    expect(remote.callCount()).toBe(before + (maxRuns ? 1 : 0));
    const [run] = await f.rows();
    expect(run?.hold_writes).toBe(!maxRuns);
    if (maxRuns) {
      expect(run?.execution_authority_id).toBe(f.authority?.id);
      await f.runTool("generic", true);
      expect(remote.callCount()).toBe(before + 1);
    }
  });
}

test("approved retries retain every primary and auxiliary credential actually sent", async () => {
  const f = await fixture({ auxiliaryCredential: true, retryCredentials: true });
  if (!f.primary || !f.auxiliary) throw new Error("missing retry connectors");
  const wire: Array<{ primary: string | undefined; secondary: string | string[] | undefined }> = [];
  remote.setHandler((request, response) => {
    wire.push({
      primary: request.headers.authorization,
      secondary: request.headers["x-secondary"],
    });
    if (wire.length === 1) {
      response.setHeader("retry-after", "0");
      jsonResponse(response, 429, { error: "try again" });
    } else jsonResponse(response, 200, { sent: true });
  });
  try {
    await f.runTool("synthetic");
    expect(wire).toHaveLength(0);
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(true);
    expect(wire).toEqual([
      { primary: "Bearer primary-credential-secret", secondary: "reviewed-test-token" },
      { primary: "Bearer primary-credential-secret", secondary: "reviewed-test-token" },
    ]);
    const run = (await f.rows()).find((row) => row.tool_approval_id !== null);
    if (!run) throw new Error("missing approved execution");
    expect(run.status).toBe("succeeded");
    expect(run.execution_authority_id).toBeNull();
    expect(
      Object.values(run.tool_approval_dispatches).map((dispatch) => dispatch.attempts),
    ).toEqual([2]);
    const [step] = await tdb.db
      .select()
      .from(executionSteps)
      .where(
        and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.execution_id, run.id)),
      );
    const snapshots = step?.credential_snapshots ?? [];
    expect(snapshots).toHaveLength(4);
    for (const connectorId of [f.primary.id, f.auxiliary.id]) {
      const [credential] = await tdb.db
        .select()
        .from(vaultItems)
        .where(
          and(
            eq(vaultItems.tenant_id, f.tenant.id),
            eq(vaultItems.connector_id, connectorId),
            eq(vaultItems.environment, "dev"),
          ),
        );
      if (!credential) throw new Error("missing retry credential");
      expect(snapshots.filter((snapshot) => snapshot.connector_id === connectorId)).toEqual([
        expect.objectContaining({
          credential_id: credential.id,
          credential_generation: credential.credential_generation,
          identity: credential.verified_identity,
        }),
        expect.objectContaining({
          credential_id: credential.id,
          credential_generation: credential.credential_generation,
          identity: credential.verified_identity,
        }),
      ]);
    }
    expect(JSON.stringify(snapshots)).not.toContain("primary-credential-secret");
    expect(JSON.stringify(snapshots)).not.toContain("reviewed-test-token");
  } finally {
    remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
  }
});

for (const rotated of [false, true]) {
  test(`auxiliary credential ${rotated ? "A-to-B-to-A requires reapproval" : "unchanged permits the exact approved dispatch"}`, async () => {
    const f = await fixture({ auxiliaryCredential: true });
    const before = remote.callCount();
    await f.runTool("synthetic");
    expect(remote.callCount()).toBe(before);
    if (rotated) {
      await f.rotateAuxiliary("changed-test-token");
      await f.rotateAuxiliary("reviewed-test-token");
    }
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(!rotated);
    expect(remote.callCount()).toBe(before + (rotated ? 0 : 1));
    if (rotated) {
      const events = await tdb.db
        .select({ reason: auditLog.reason })
        .from(auditLog)
        .where(
          and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "approval.dispatch_denied")),
        );
      expect(events.some((event) => event.reason === "prepared_request_changed")).toBe(true);
    }
  });
}

for (const rotated of [false, true]) {
  test(`credential used only by an earlier read ${rotated ? "requires a new decision after rotation" : "allows an unchanged write"}`, async () => {
    const f = await fixture({ upstreamCredential: true });
    const before = remote.callCount();
    await f.runTool("synthetic");
    expect(remote.callCount()).toBe(before + 1);
    if (rotated) {
      await f.rotateAuxiliary("changed-test-token");
      await f.rotateAuxiliary("reviewed-test-token");
    }
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(!rotated);
    expect(remote.callCount()).toBe(before + (rotated ? 2 : 3));
  });
}

test("auxiliary credential revision is rechecked after materialization before dispatch", async () => {
  const f = await fixture({ auxiliaryCredential: true });
  if (!f.auxiliary) throw new Error("missing auxiliary");
  const [credential] = await tdb.db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.tenant_id, f.tenant.id), eq(vaultItems.connector_id, f.auxiliary.id)));
  if (!credential) throw new Error("missing credential");
  await f.runTool("synthetic");
  await f.confirmPrepared();
  const run = (await f.rows()).find((row) => row.tool_approval_id);
  if (!run) throw new Error("missing run");
  const stepId = Object.keys(run.tool_approval_dispatches)[0];
  if (!stepId) throw new Error("missing step");
  await tdb.db
    .update(executions)
    .set({ status: "running" })
    .where(and(eq(executions.tenant_id, f.tenant.id), eq(executions.id, run.id)));
  await tdb.db
    .update(executionSteps)
    .set({ status: "running" })
    .where(and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.id, stepId)));
  const key = `${run.id}:${stepId}:0`;
  const snapshot: RequestAuthoritySnapshot = {
    step_id: "send",
    step_row_id: stepId,
    connector_id: null,
    requires_review: true,
    request_max_attempts: 5,
    principal_id: actorId,
    configuration_digest: authorityConnectorDigest(null),
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
    referenced_authorities: await capturePreparedWorkflowReferences(
      tdb.db,
      f.tenant.id,
      "dev",
      WorkflowDefSchema.parse(f.definition),
    ),
    request: {
      method: "POST",
      url: `${remote.baseUrl}/messages`,
      headers: { Authorization: "Bearer reviewed-test-token", "Idempotency-Key": key },
      body: { recipient: "reviewed@example.test" },
      generated_idempotency: { key, page: 0 },
    },
  };
  await f.rotateAuxiliary("changed-test-token");
  await f.rotateAuxiliary("reviewed-test-token");
  const before = remote.callCount();
  await expect(
    assertToolApprovalDispatch(tdb.db, f.tenant.id, run.id, snapshot),
  ).rejects.toMatchObject({ code: "prepared_reference_credential_changed" });
  expect(remote.callCount()).toBe(before);
  expect(
    (await f.rows()).find((row) => row.id === run.id)?.tool_approval_dispatches[stepId]?.attempts,
  ).toBe(1);
});

test("a held chat approval replays its exact prepared version once", async () => {
  const f = await fixture();
  const before = remote.callCount();
  await f.runTool("synthetic");
  expect(remote.callCount()).toBe(before);
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.ok).toBe(true);
  expect(remote.callCount()).toBe(before + 1);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.every((run) => run.workflow_version_id === f.version.id)).toBe(true);
  const events = await tdb.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.tenant_id, f.tenant.id));
  expect(events.filter((event) => event.action === "approval.execution_bound")).toHaveLength(1);
  expect(events.filter((event) => event.action === "approval.dispatch_reserved")).toHaveLength(1);
  await f.confirmPrepared();
  expect(remote.callCount()).toBe(before + 1);
});

for (const container of [undefined, "loop", "parallel"] as const) {
  for (const changed of [false, true]) {
    test(`held approval ${changed ? "rejects a changed" : "accepts an unchanged"} recipient from a live lookup (${container ?? "direct"})`, async () => {
      let recipient = "reviewed@example.test";
      let writes = 0;
      remote.setHandler((request, response) => {
        if (request.method === "POST") writes += 1;
        jsonResponse(response, 200, { recipient, sent: true });
      });
      try {
        const f = await fixture({ lookupRecipient: true, ...(container ? { container } : {}) });
        await f.runTool("synthetic");
        expect(writes).toBe(0);
        const [preparedRun] = await f.rows();
        if (!preparedRun) throw new Error("missing held run");
        const prepared = await capturePreparedWorkflowBinding({
          db: tdb.db,
          tenant_id: f.tenant.id,
          execution_id: preparedRun.id,
          tool: `wf_${f.workflow.slug}`,
          execution_mode: "dev",
          args: {},
        });
        expect(prepared.request_reviews).toHaveLength(1);
        expect(prepared.request_reviews?.[0]?.redacted_request_json).toContain(
          "reviewed@example.test",
        );
        expect(prepared.request_reviews?.[0]?.max_attempts).toBe(5);
        expect(prepared.request_reviews?.[0]?.step).toBe(prepared.request_proofs?.[0]?.step_key);
        if (changed) recipient = "unreviewed@example.test";
        const result = await f.confirmPrepared();
        expect(result.synthetic_result?.ok).toBe(!changed);
        expect(result.synthetic_result?.data).toMatchObject({
          writes_executed: !changed,
          write_outcome: changed ? "not_dispatched" : "completed",
          write_attempts_reserved: changed ? 0 : 1,
        });
        expect(writes).toBe(changed ? 0 : 1);
        const failures = await tdb.db
          .select({ error: executionSteps.error })
          .from(executionSteps)
          .where(
            and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.status, "failed")),
          );
        if (changed) expect(failures.length).toBeGreaterThanOrEqual(1);
        else expect(failures).toHaveLength(0);
        if (changed) expect(failures[0]?.error).toMatchObject({ code: "authority_invalid" });
      } finally {
        remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
      }
    });
  }
}

for (const invalidation of ["expired", "declined"] as const) {
  test(`a ${invalidation} approval between lookup and write stops the outbound write`, async () => {
    const f = await fixture({ lookupRecipient: true });
    let invalidate = false;
    let writes = 0;
    remote.setHandler(async (request, response) => {
      if (request.method === "POST") writes += 1;
      if (invalidate && request.method === "GET") {
        const now = await databaseNow(tdb.db);
        await tdb.db
          .update(toolApprovals)
          .set(invalidation === "expired" ? { expires_at: now } : { declined_at: now })
          .where(eq(toolApprovals.tenant_id, f.tenant.id));
      }
      jsonResponse(response, 200, { recipient: "reviewed@example.test" });
    });
    try {
      await f.runTool("synthetic");
      invalidate = true;
      const result = await f.confirmPrepared();
      expect(result.synthetic_result?.ok).toBe(false);
      expect(result.synthetic_result?.data).toMatchObject({
        writes_executed: false,
        write_outcome: "not_dispatched",
      });
      expect(writes).toBe(0);
    } finally {
      remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
    }
  });
}

test("single-use execution identity and reservation counters cannot be rewritten", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  await f.confirmPrepared();
  const run = (await f.rows()).find((row) => row.tool_approval_id);
  if (!run) throw new Error("missing approved execution");
  const boundary = and(eq(executions.tenant_id, f.tenant.id), eq(executions.id, run.id));
  const [stepId, reservation] = Object.entries(run.tool_approval_dispatches)[0] ?? [];
  if (!stepId || !reservation) throw new Error("missing dispatch reservation");
  for (const change of [
    { tool_approval_id: null },
    { input: { unreviewed: true } },
    { tool_approval_dispatches: {} },
    { tool_approval_dispatches: { [stepId]: { ...reservation, attempts: 0 } } },
    { tool_approval_dispatches: { [stepId]: { ...reservation, digest: "b".repeat(64) } } },
  ])
    await expect(tdb.db.update(executions).set(change).where(boundary).execute()).rejects.toThrow();
  const { id: _id, ...copy } = run;
  const replacement = { ...copy, status: "queued" as const, tool_approval_dispatches: {} };
  await expect(tdb.db.insert(executions).values(replacement).execute()).rejects.toThrow();
  await expect(
    tdb.db
      .update(toolApprovals)
      .set({ claimed_execution_id: null })
      .where(
        and(
          eq(toolApprovals.tenant_id, f.tenant.id),
          eq(toolApprovals.id, run.tool_approval_id as string),
        ),
      )
      .execute(),
  ).rejects.toThrow();
  await tdb.db.delete(executions).where(boundary);
  const [recreated] = await tdb.db.insert(executions).values(replacement).returning();
  if (!recreated) throw new Error("missing recreated execution");
  await expect(assertToolApprovalDispatch(tdb.db, f.tenant.id, recreated.id)).rejects.toMatchObject(
    { code: "tool_approval_already_bound" },
  );
});

test("parallel dispatch reservations cannot exceed the prepared retry limit", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  await f.confirmPrepared();
  const run = (await f.rows()).find((row) => row.tool_approval_id);
  if (!run) throw new Error("missing approved execution");
  const stepId = Object.keys(run.tool_approval_dispatches)[0];
  if (!stepId) throw new Error("missing dispatch reservation");
  await tdb.db
    .update(executions)
    .set({ status: "running" })
    .where(and(eq(executions.tenant_id, f.tenant.id), eq(executions.id, run.id)));
  const key = `${run.id}:${stepId}:0`;
  await tdb.db
    .update(executionSteps)
    .set({ status: "running" })
    .where(and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.id, stepId)));
  const snapshot: RequestAuthoritySnapshot = {
    step_id: "send",
    step_row_id: stepId,
    connector_id: null,
    requires_review: true,
    request_max_attempts: 5,
    principal_id: actorId,
    configuration_digest: authorityConnectorDigest(null),
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
    request: {
      method: "POST",
      url: `${remote.baseUrl}/messages`,
      headers: { "Idempotency-Key": key },
      body: { recipient: "reviewed@example.test" },
      generated_idempotency: { key, page: 0 },
    },
  };
  const before = remote.callCount();
  const reservations = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      assertToolApprovalDispatch(tdb.db, f.tenant.id, run.id, snapshot),
    ),
  );
  expect(reservations.filter((result) => result.status === "fulfilled")).toHaveLength(4);
  const rejections = reservations.filter((result) => result.status === "rejected");
  expect(rejections).toHaveLength(2);
  for (const result of rejections)
    if (result.status === "rejected")
      expect(result.reason).toMatchObject({ code: "prepared_effect_exhausted" });
  expect(
    (await f.rows()).find((row) => row.id === run.id)?.tool_approval_dispatches[stepId]?.attempts,
  ).toBe(5);
  expect(remote.callCount()).toBe(before);
});

test("an unsuccessful dispatched write reports an uncertain external outcome", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  remote.setHandler((_, response) => jsonResponse(response, 503, { unavailable: true }));
  try {
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(false);
    expect(result.synthetic_result?.data).toMatchObject({
      writes_executed: null,
      write_outcome: "unknown",
      write_attempts_reserved: 1,
    });
  } finally {
    remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
  }
});

test("a parent one-shot approval cannot escape through an unbound child workflow", async () => {
  const f = await fixture();
  const [child] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: f.tenant.id, slug: "child-send", name: "child-send", lifecycle: "active" })
    .returning();
  if (!child) throw new Error("missing child workflow");
  const [childVersion] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: child.id,
      version: 1,
      dag: { name: "child-send", steps: f.definition.steps },
    })
    .returning();
  if (!childVersion) throw new Error("missing child version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: childVersion.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, child.id)));
  const [parentVersion] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: {
        ...f.definition,
        steps: [...f.definition.steps, { id: "call_child", kind: "call", workflow_id: child.id }],
      },
    })
    .returning();
  if (!parentVersion) throw new Error("missing parent version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: parentVersion.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  await f.runTool("synthetic");
  expect(remote.callCount()).toBe(before);
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.ok).toBe(false);
  expect(remote.callCount()).toBe(before + 1);
  expect(result.synthetic_result?.data).toMatchObject({
    writes_executed: true,
    write_outcome: "partially_completed",
  });
  const denials = await tdb.db
    .select({ reason: auditLog.reason })
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.reason, "prepared_call_unsupported")),
    );
  expect(denials).toHaveLength(1);
});

for (const inlineEach of [false, true]) {
  for (const scenario of ["unchanged", "swapped", "duplicate", "partially_changed"] as const) {
    test(`${inlineEach ? "for_each" : "loop"} approvals bind occurrence order (${scenario})`, async () => {
      let recipients = [
        { recipient: "first@example.test" },
        { recipient: scenario === "duplicate" ? "first@example.test" : "second@example.test" },
      ];
      let writes = 0;
      remote.setHandler((request, response) => {
        if (request.method === "POST") writes += 1;
        jsonResponse(response, 200, { recipients });
      });
      try {
        const f = await fixture({
          lookupRecipient: true,
          loopRecipients: true,
          ...(inlineEach ? { inlineEach: true } : { container: "loop" }),
        });
        await f.runTool("synthetic");
        expect(writes).toBe(0);
        if (scenario === "swapped") recipients = [...recipients].reverse();
        if (scenario === "partially_changed")
          recipients = [
            { recipient: "first@example.test" },
            { recipient: "unreviewed@example.test" },
          ];
        const result = await f.confirmPrepared();
        expect(result.synthetic_result?.ok).toBe(
          scenario === "unchanged" || scenario === "duplicate",
        );
        expect(writes).toBe(scenario === "swapped" ? 0 : scenario === "partially_changed" ? 1 : 2);
        expect(result.synthetic_result?.data).toMatchObject({
          writes_executed: scenario !== "swapped",
          write_attempts_reserved:
            scenario === "swapped" ? 0 : scenario === "partially_changed" ? 1 : 2,
          write_outcome:
            scenario === "swapped"
              ? "not_dispatched"
              : scenario === "partially_changed"
                ? "partially_completed"
                : "completed",
        });
      } finally {
        remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
      }
    });
  }
}
