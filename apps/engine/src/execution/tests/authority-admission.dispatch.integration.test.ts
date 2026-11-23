import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getConnectorForEnvironment } from "../../connectors/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import {
  connectors,
  executionSteps,
  executions,
  outboundConnections,
  vaultItems,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createMockServer, jsonResponse } from "../../test-helpers/mock-http.ts";
import { authorityConnectorDigest } from "../../workflows/authority-configuration.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../authority-admission.ts";
import { bindExistingRun } from "../bound-run.ts";
import { runRequestStep } from "../steps/request.ts";
import type { StepRunContext } from "../types.ts";
import { actor, authorityAdmissionFixtures } from "./authority-admission-fixtures.ts";

let ctx: TestDb;

const { fixture, reservations } = authorityAdmissionFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("authority_admission");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("a changed target cannot spend the explicitly supplied old authority", async () => {
  const f = await fixture();
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://other.example.test/api" })
    .where(eq(connectors.id, f.connector.id));
  await expect(
    admitAuthorizedWorkflowExecution(
      { ...f.params, execution_authority_id: f.authority.id },
      ctx.db,
    ),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  expect(await reservations(f.authority.id)).toBe(0);
});

test("revocation between queueing and dispatch blocks an existing reservation", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await ctx.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: await databaseNow(ctx.db), revoked_by: actor })
    .where(eq(workflowExecutionAuthorities.id, f.authority.id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_revoked" });
  expect(await reservations(f.authority.id)).toBe(1);
});

test("target drift after queueing is checked again before dispatch", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://other.example.test/api" })
    .where(eq(connectors.id, f.connector.id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
});

test("dispatch matches its exact step and captured configuration, even after the database is restored", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  const connector = await getConnectorForEnvironment(
    f.params.tenant_id,
    f.connector.id,
    "dev",
    ctx.db,
  );
  if (!connector) throw new Error("missing resolved connector");
  const snapshot = {
    step_id: "send",
    configuration_digest: authorityConnectorDigest(connector),
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
  };
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, snapshot);
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, {
      ...snapshot,
      connection_authority: { id: actor, revision: 1 },
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  const changed = { ...connector, base_url: "https://changed.example.test" };
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, {
      ...snapshot,
      configuration_digest: authorityConnectorDigest(changed),
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, {
      ...snapshot,
      step_id: "unapproved-step",
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
});

for (const driver of ["http", "graphql"] as const) {
  test(`${driver} binds loaded configuration and credentials and never follows an unapproved redirect`, async () => {
    let sent = 0;
    let redirect = false;
    const remote = await createMockServer((req, res) => {
      sent++;
      if (redirect && req.url !== "/unapproved") {
        res.writeHead(307, { location: "/unapproved" });
        res.end();
        return;
      }
      jsonResponse(res, 200, { ok: true, data: { sendReport: { id: "receipt" } } });
    });
    try {
      for (const change of [
        "none",
        "configuration",
        "credential",
        "credential_missing",
        "redirect",
        "connection_valid",
        "connection_changed",
      ] as const) {
        const changed = change !== "none" && change !== "connection_valid";
        redirect = change === "redirect";
        const f = await fixture(2, undefined, undefined, {
          base_url: remote.baseUrl,
          driver,
          credential: change.startsWith("connection") ? "connection" : true,
        });
        const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
        if (change === "connection_changed") {
          if (!f.connection) throw new Error("missing connection fixture");
          await ctx.db
            .update(outboundConnections)
            .set({ authority_revision: 2, granted_scopes: ["read", "write", "admin"] })
            .where(
              and(
                eq(outboundConnections.tenant_id, f.params.tenant_id),
                eq(outboundConnections.id, f.connection.id),
              ),
            );
        }
        const [originalCredential] = await ctx.db
          .select()
          .from(vaultItems)
          .where(
            and(
              eq(vaultItems.tenant_id, f.params.tenant_id),
              eq(vaultItems.connector_id, f.connector.id),
            ),
          );
        if (!originalCredential) throw new Error("missing credential fixture");
        if (change === "credential_missing")
          await ctx.db
            .update(vaultItems)
            .set({ deleted_at: await databaseNow(ctx.db) })
            .where(eq(vaultItems.id, originalCredential.id));
        if (change === "credential")
          await upsertCredential(
            {
              tenant_id: f.params.tenant_id,
              connector_id: f.connector.id,
              environment: "dev",
              mode: "bearer",
              actor_id: null,
              value: { mode: "bearer", token: "unapproved-fixture-token" },
            },
            ctx.db,
          );
        const step = WorkflowDefSchema.parse(f.version.dag).steps[0];
        if (step?.kind !== "request") throw new Error("missing request fixture");
        const [stepRow] = await ctx.db
          .insert(executionSteps)
          .values({
            tenant_id: f.params.tenant_id,
            execution_id: run.execution_id,
            step_key: step.id,
            step_index: 0,
            kind: "request",
            status: "running",
          })
          .returning();
        if (!stepRow) throw new Error("missing step fixture");
        if (change === "configuration")
          await ctx.db
            .update(connectors)
            .set({ base_url: `${remote.baseUrl}/changed` })
            .where(eq(connectors.id, f.connector.id));
        let checked = 0;
        const context: StepRunContext = {
          db: ctx.db,
          tenant_id: f.params.tenant_id,
          execution_id: run.execution_id,
          workflow_id: f.workflow.id,
          workflow_version_id: f.version.id,
          request_source: "api",
          parent_execution_id: null,
          depth: 0,
          signal: new AbortController().signal,
          scope: {},
          started_at: new Date(getTestNow()),
          workflow_slug: f.workflow.slug,
          trace_id: null,
          principal: null,
          execution_mode: "dev",
          step,
          step_index: 0,
          step_row_id: stepRow.id,
          persist_workflow_refs: true,
          llm_budget: new RunLlmBudget(null),
          before_external_request: async (snapshot) => {
            checked++;
            if (change === "credential_missing") {
              expect(snapshot.credential_id).toBeNull();
              await ctx.db
                .update(vaultItems)
                .set({ deleted_at: null })
                .where(eq(vaultItems.id, originalCredential.id));
            }
            if (change === "connection_changed") {
              if (!f.connection) throw new Error("missing connection fixture");
              expect(snapshot.connection_authority).toEqual({ id: f.connection.id, revision: 2 });
              await ctx.db
                .update(outboundConnections)
                .set({
                  authority_revision: f.connection.authority_revision,
                  granted_scopes: f.connection.granted_scopes,
                })
                .where(
                  and(
                    eq(outboundConnections.tenant_id, f.params.tenant_id),
                    eq(outboundConnections.id, f.connection.id),
                  ),
                );
            }
            if (change === "configuration")
              await ctx.db
                .update(connectors)
                .set({ base_url: f.connector.base_url })
                .where(eq(connectors.id, f.connector.id));
            if (change === "credential")
              await ctx.db
                .update(vaultItems)
                .set({
                  ciphertext: originalCredential.ciphertext,
                  iv: originalCredential.iv,
                  auth_tag: originalCredential.auth_tag,
                  authority_revision: originalCredential.authority_revision,
                })
                .where(
                  and(
                    eq(vaultItems.tenant_id, f.params.tenant_id),
                    eq(vaultItems.id, originalCredential.id),
                  ),
                );
            return await assertExecutionAuthorityCurrent(
              ctx.db,
              f.params.tenant_id,
              run.execution_id,
              snapshot,
            );
          },
        };
        const before = sent;
        const result = await runRequestStep({ ctx: context, step, scope: {} });
        expect(checked).toBe(1);
        expect(result.status).toBe(changed ? "failed" : "succeeded");
        expect(sent - before).toBe(changed && !redirect ? 0 : 1);
        if (changed)
          expect(result.error?.code).toBe(
            redirect ? "authority_redirect_denied" : "execution_authority_changed",
          );
      }
    } finally {
      await remote.close();
    }
  });
}

test("worker binding fixes execution options and refuses wider replay overrides", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  const source = { kind: "saved" as const, workflow_id: f.workflow.id };
  const options = { existing_execution_id: run.execution_id };
  const bound = await bindExistingRun(ctx.db, f.params.tenant_id, source, f.params.input, options);
  expect(bound.source).toMatchObject({ version_id: f.version.id });
  expect(bound.options).toMatchObject({
    execution_mode: "dev",
    self_healing: { enabled: false },
    hold_writes: false,
  });
  for (const patch of [
    { self_healing: { enabled: true } },
    { step_output_fixtures: {} },
    { hold_writes: true },
  ]) {
    await expect(
      bindExistingRun(ctx.db, f.params.tenant_id, source, f.params.input, { ...options, ...patch }),
    ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  }
});

test("switching the active version blocks a queued old-version run", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.params.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: f.version.dag,
    })
    .returning();
  if (!next) throw new Error("missing replacement version");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: next.id })
    .where(eq(workflows.id, f.workflow.id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_required" });
});

test("expiry after admission still blocks dispatch", async () => {
  const expires = new Date((await databaseNow(ctx.db)).getTime() + 3_000);
  const f = await fixture(1, undefined, expires);
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id);
  await waitFor(async () => (await databaseNow(ctx.db)).getTime() >= expires.getTime(), {
    tries: 200,
    sleepMs: 25,
    label: "PostgreSQL crosses the immutable authority deadline",
  });
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_expired" });
});

test("tenant mismatch and cancellation cannot dispatch the reserved run", async () => {
  const f = await fixture();
  const other = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, other.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  await ctx.db
    .update(executions)
    .set({ abort_requested_at: await databaseNow(ctx.db) })
    .where(eq(executions.id, run.execution_id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
});
