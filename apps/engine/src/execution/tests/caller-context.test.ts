import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { auditLog, executionSteps, executions } from "../../db/schema/index.ts";
import { resolveStringPlaceholders } from "../../llm/substitution/resolver.ts";
import { can } from "../../rbac/evaluator.ts";
import { bindExistingRun } from "../bound-run.ts";
import { runExecution } from "../engine.ts";
import { createExecution } from "../state.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let workflowId: string;

function principal(id: string): ResolvedPrincipal & { product_id: string } {
  return {
    provider: "test",
    kind: "user",
    id,
    tenant_id: ctx.tenantId,
    roles: ["enduser"],
    product_id: "harmoniqs",
  };
}

beforeAll(async () => {
  ctx = await createEngineCtx("caller-context");
  const workflow = await createWorkflowRow(ctx, {
    name: "Observe trusted caller",
    slug: "observe-trusted-caller",
    product_id: "harmoniqs",
    steps: [
      {
        id: "observe",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.$caller ?? null;",
      },
    ],
  });
  workflowId = workflow.workflow_id;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe("authenticated execution caller", () => {
  test("domain execution rejects product draft and step sources before creating an execution", async () => {
    const owner = principal("00000000-0000-4000-8000-000000000015");
    const step = {
      id: "inline",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: "return 1;",
    };
    const before = await ctx.testDb.db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    for (const source of [
      {
        kind: "draft" as const,
        definition: { name: "Self declared product", product_id: "harmoniqs", steps: [step] },
      },
      { kind: "step" as const, step },
    ]) {
      await expect(
        runExecution({
          db: ctx.testDb.db,
          tenant_id: ctx.tenantId,
          source,
          input: null,
          options: { principal: owner, hold_writes: true },
        }),
      ).rejects.toMatchObject({ code: "caller_saved_workflow_required" });
    }
    const after = await ctx.testDb.db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    expect(after).toHaveLength(before.length);
  });

  for (const iteration of ["for_each"]) {
    test(`${iteration} iterations preserve the authenticated caller despite item spoofing`, async () => {
      const owner = principal("00000000-0000-4000-8000-000000000015");
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "Iterated caller identity",
        slug: `iterated-caller-${iteration}`,
        product_id: "harmoniqs",
        steps: [
          {
            id: "source",
            kind: "transform",
            language: "javascript",
            expression:
              "return [{ $caller: { principalId: 'foreign' } }, { principalId: 'foreign' }];",
          },
          {
            id: "observe",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.$caller;",
            ...(iteration === "for_each" ? { for_each: "(scope) => scope.source.data" } : {}),
          },
        ],
      });
      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: { $caller: { principalId: "foreign" } },
        options: { principal: owner, hold_writes: true },
      });
      expect(result.status).toBe("succeeded");
      const caller = {
        tenantId: ctx.tenantId,
        principalId: owner.id,
        principalKind: "user",
        provider: "test",
        productId: "harmoniqs",
      };
      const steps = await ctx.testDb.db
        .select()
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, ctx.tenantId),
            eq(executionSteps.execution_id, result.execution_id),
          ),
        );
      const bodies = steps.filter((step) => step.step_key.startsWith("observe["));
      expect(bodies).toHaveLength(2);
      for (const body of bodies) expect(body.output_preview).toEqual(caller);
    });
  }

  for (const id of [
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
  ]) {
    test(`input owner cannot replace authenticated principal ${id}`, async () => {
      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id: workflowId },
        input: {
          owner_id: "another-owner",
          product_id: "another-product",
          $caller: {
            tenantId: "another-tenant",
            principalId: "another-owner",
            productId: "another-product",
          },
        },
        options: { principal: principal(id), hold_writes: true },
      });
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({
        tenantId: ctx.tenantId,
        principalId: id,
        principalKind: "user",
        provider: "test",
        productId: "harmoniqs",
      });
      const audit = await ctx.testDb.db
        .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, ctx.tenantId),
            eq(auditLog.resource_id, result.execution_id),
            eq(auditLog.action, "execution.started"),
          ),
        );
      expect(audit).toContainEqual({ actor_type: "user", actor_id: id });
    });
  }

  test("anonymous input cannot run a product workflow", async () => {
    const result = runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflowId },
      input: { $caller: { principalId: "another-owner", productId: "harmoniqs" } },
      options: { hold_writes: true },
    });
    await expect(result).rejects.toMatchObject({ code: "caller_required" });
  });

  test("a different product principal cannot run the workflow", async () => {
    const result = runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflowId },
      input: { product_id: "harmoniqs" },
      options: {
        hold_writes: true,
        principal: { ...principal("00000000-0000-4000-8000-000000000013"), product_id: "other" },
      },
    });
    await expect(result).rejects.toMatchObject({ code: "caller_product_mismatch" });
  });

  test("internal caller override cannot disagree with the authenticated principal", async () => {
    const authenticated = principal("00000000-0000-4000-8000-000000000031");
    await expect(
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id: workflowId },
        input: null,
        options: {
          principal: authenticated,
          caller_context: {
            tenantId: ctx.tenantId,
            principalId: "00000000-0000-4000-8000-000000000032",
            principalKind: "user",
            provider: "test",
            productId: "harmoniqs",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  });

  test("a principal from another tenant cannot execute under the target tenant", async () => {
    const result = runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflowId },
      input: null,
      options: {
        hold_writes: true,
        principal: {
          ...principal("00000000-0000-4000-8000-000000000014"),
          tenant_id: "00000000-0000-4000-8000-000000000015",
        },
      },
    });
    await expect(result).rejects.toMatchObject({ code: "caller_tenant_mismatch" });
  });

  test("generic authenticated workflows receive a caller without inventing a product", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "Generic authenticated caller",
      slug: "generic-authenticated-caller",
      steps: [
        {
          id: "observe",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.$caller ?? null;",
        },
      ],
    });
    const authenticated: ResolvedPrincipal = {
      provider: "test",
      kind: "system_account",
      id: "00000000-0000-4000-8000-000000000016",
      tenant_id: ctx.tenantId,
      roles: ["member"],
    };
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { product_id: "harmoniqs" },
      options: { principal: authenticated, hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      tenantId: ctx.tenantId,
      principalId: authenticated.id,
      principalKind: "system_account",
      provider: "test",
      productId: null,
    });
  });

  test("product principal scopes and workflow allowlist still cap an admin role", async () => {
    const scoped: ResolvedPrincipal = {
      ...principal("00000000-0000-4000-8000-000000000017"),
      roles: ["admin"],
      scopes: ["workflow:run"],
      allowed_workflows: [workflowId],
    };
    const check = {
      tenant_id: ctx.tenantId,
      principal: scoped,
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowId },
    };
    expect((await can(ctx.testDb.db, check)).allow).toBe(true);
    expect(
      await can(ctx.testDb.db, {
        ...check,
        resource: { type: "workflow", id: "00000000-0000-4000-8000-000000000018" },
      }),
    ).toMatchObject({ allow: false, source: "credential_ceiling" });
    expect(await can(ctx.testDb.db, { ...check, permission: "connector:write" })).toMatchObject({
      allow: false,
      source: "credential_ceiling",
    });
  });

  test("request placeholders read caller scope and never fall back to spoofed input", async () => {
    const caller = {
      tenantId: ctx.tenantId,
      principalId: "00000000-0000-4000-8000-000000000019",
      principalKind: "user",
      provider: "test",
      productId: "harmoniqs",
    };
    const resolver = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      environment: "dev" as const,
      input: {
        caller: { principalId: "another-owner" },
        $caller: { principalId: "another-owner" },
      },
    };
    const template = `products/harmoniqs/\${caller.principalId}/song.json`;
    const resolved = await resolveStringPlaceholders(template, {
      ...resolver,
      scope: { $caller: caller },
    });
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.value).toBe(`products/harmoniqs/${caller.principalId}/song.json`);
    const missing = await resolveStringPlaceholders(template, resolver);
    expect(missing.unresolved).toHaveLength(1);
    expect(missing.value).not.toContain("another-owner");
    for (const field of ["roles", "scopes", "api_key_id", "password"]) {
      const unavailable = await resolveStringPlaceholders(`\${caller.${field}}`, {
        ...resolver,
        scope: { $caller: caller },
      });
      expect(unavailable.unresolved).toHaveLength(1);
    }
  });

  test("a child workflow keeps its parent's authenticated caller despite spoofed child input", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "Product caller parent",
      slug: "product-caller-parent",
      product_id: "harmoniqs",
      steps: [
        {
          id: "child",
          kind: "call",
          workflow_id: workflowId,
          input: { $caller: { principalId: "another-owner", productId: "another-product" } },
        },
      ],
    });
    const authenticated = principal("00000000-0000-4000-8000-000000000020");
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { principal: authenticated, hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({
      status: "succeeded",
      output: {
        tenantId: ctx.tenantId,
        principalId: authenticated.id,
        principalKind: "user",
        provider: "test",
        productId: "harmoniqs",
      },
    });
    const children = await ctx.testDb.db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenantId),
          eq(executions.parent_execution_id, result.execution_id),
        ),
      );
    expect(children).toHaveLength(1);
    for (const executionId of [result.execution_id, children[0]?.id]) {
      const [row] = await ctx.testDb.db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId ?? "")));
      expect(row?.caller_origin).toBe("principal");
      const audits = await ctx.testDb.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, executionId ?? "")),
        );
      for (const action of [
        AuditAction.EXECUTION_QUEUED,
        AuditAction.EXECUTION_STARTED,
        AuditAction.EXECUTION_COMPLETED,
      ]) {
        expect(audits.filter((audit) => audit.action === action)).toHaveLength(1);
        expect(audits.find((audit) => audit.action === action)).toMatchObject({
          actor_type: "user",
          actor_id: authenticated.id,
        });
      }
    }
  });

  test("a trusted system child inherits provenance without inventing a caller", async () => {
    const child = await createWorkflowRow(ctx, {
      name: "System caller child",
      slug: "system-caller-child",
      steps: [
        { id: "observe", kind: "transform", expression: "return input.scope.$caller ?? null;" },
      ],
    });
    const parent = await createWorkflowRow(ctx, {
      name: "System caller parent",
      slug: "system-caller-parent",
      steps: [
        {
          id: "child",
          kind: "call",
          workflow_id: child.workflow_id,
          input: { caller_origin: "principal" },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: null,
      options: { hold_writes: true, caller_origin: "trusted_system" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({ status: "succeeded", output: null });
    const children = await ctx.testDb.db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenantId),
          eq(executions.parent_execution_id, result.execution_id),
        ),
      );
    expect(children).toHaveLength(1);
    const childRow = children[0];
    expect(childRow?.caller_origin).toBe("trusted_system");
    expect(childRow?.caller_context).toBeNull();
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, childRow?.id ?? "")),
      );
    for (const action of [
      AuditAction.EXECUTION_QUEUED,
      AuditAction.EXECUTION_STARTED,
      AuditAction.EXECUTION_COMPLETED,
    ]) {
      expect(audits.filter((audit) => audit.action === action)).toHaveLength(1);
      expect(audits.find((audit) => audit.action === action)).toMatchObject({
        actor_type: "system",
        actor_id: null,
      });
    }
  });

  for (const origin of ["unknown", "principal"] as const) {
    test(`resume preserves ${origin} provenance and refuses caller or origin replacement`, async () => {
      const authenticated = principal("00000000-0000-4000-8000-000000000022");
      const { workflow_id, version_id } = await createWorkflowRow(ctx, {
        name: `Resume caller boundary ${origin}`,
        slug: `resume-caller-boundary-${origin}`,
        product_id: "harmoniqs",
        steps: [{ id: "observe", kind: "transform", expression: "return input.scope.$caller;" }],
      });
      const caller = {
        tenantId: ctx.tenantId,
        principalId: authenticated.id,
        principalKind: "user" as const,
        provider: "test",
        productId: "harmoniqs",
      };
      const execution_id = await createExecution(ctx.testDb.db, {
        tenant_id: ctx.tenantId,
        workflow_id,
        workflow_version_id: version_id,
        source_kind: "saved",
        source_ref: null,
        request_source: "api",
        hold_writes: true,
        input: null,
        caller_context: caller,
        ...(origin === "principal" ? { caller_origin: origin } : {}),
      });
      const source = { kind: "saved" as const, workflow_id };
      const resumed = await bindExistingRun(ctx.testDb.db, ctx.tenantId, source, null, {
        existing_execution_id: execution_id,
        principal: principal(caller.principalId),
      });
      expect(resumed.options.caller_context).toEqual(caller);
      expect(resumed.options.caller_origin).toBe(origin);
      await expect(
        bindExistingRun(ctx.testDb.db, ctx.tenantId, source, null, {
          existing_execution_id: execution_id,
          principal: principal("00000000-0000-4000-8000-000000000023"),
        }),
      ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
      await expect(
        bindExistingRun(ctx.testDb.db, ctx.tenantId, source, null, {
          existing_execution_id: execution_id,
          principal: authenticated,
          caller_origin: origin === "unknown" ? "principal" : "trusted_system",
        }),
      ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
      const [unchanged] = await ctx.testDb.db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, execution_id)));
      expect(unchanged?.caller_origin).toBe(origin);
      expect(unchanged?.caller_context).toEqual(caller);
      const result = await runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source,
        input: null,
        options: { existing_execution_id: execution_id, principal: authenticated },
      });
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual(caller);
      const audits = await ctx.testDb.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, execution_id)));
      for (const action of [
        AuditAction.EXECUTION_QUEUED,
        AuditAction.EXECUTION_STARTED,
        AuditAction.EXECUTION_COMPLETED,
      ]) {
        expect(audits.filter((audit) => audit.action === action)).toHaveLength(1);
        expect(audits.find((audit) => audit.action === action)).toMatchObject({
          actor_type: origin === "principal" ? "user" : "unknown",
          actor_id: origin === "principal" ? authenticated.id : null,
        });
      }
    });
  }

  test("JSONata output transforms use trusted caller despite caller-shaped step output", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "Caller JSONata output",
      slug: "caller-jsonata-output",
      product_id: "harmoniqs",
      steps: [
        {
          id: "shape",
          kind: "transform",
          expression: "return { caller: { principalId: 'another-owner' } };",
        },
      ],
      output_transform: "$caller",
    });
    const authenticated = principal("00000000-0000-4000-8000-000000000024");
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { caller: { principalId: "another-owner" } },
      options: { principal: authenticated, hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      tenantId: ctx.tenantId,
      principalId: authenticated.id,
      principalKind: "user",
      provider: "test",
      productId: "harmoniqs",
    });
  });
});
