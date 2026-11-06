import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { callerBudgetUnits, userIdentities, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { admitWorkflowRun } from "../workflow-run-admission.ts";
import type { EngineTestCtx } from "./setup.ts";

const roundSteps = [
  { id: "gate", kind: "transform", expression: "return { ok: true };" },
  {
    id: "round",
    kind: "transform",
    expression:
      "return input.input.final ? { output: [{ type: 'message' }] } : { output: [{ type: 'function_call' }] };",
  },
];

export function guardedDefinition(limit: number, extra: Record<string, unknown> = {}) {
  return {
    name: `guarded ${limit}`,
    product_id: "testapp",
    required_caller_kind: "user",
    execution_privacy: "sensitive",
    steps: roundSteps,
    execution_guards: {
      caller_daily_limit: {
        bucket: "brain",
        limit,
        tz: "Europe/Berlin",
        unit: "turn_id",
        billable_steps: ["round"],
        max_metered: 3,
        commit_when: "$count(output[type = 'function_call']) = 0",
        ...extra,
      },
      input_bytes: { request: 64 },
    },
  };
}

export function callerBudgetFixtures(state: {
  readonly ctx: EngineTestCtx;
  readonly roundWorkflow: string;
}) {
  const nextUuid = createDeterministicUuidFactory(211);

  async function productUser(): Promise<ResolvedPrincipal> {
    const subject = nextUuid();
    const [user] = await state.ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: state.ctx.tenantId,
        email: `testapp-supabase:${subject}@invalid`,
        role_id: await builtinRoleId(state.ctx.testDb.db, "member"),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("user fixture missing");
    await state.ctx.testDb.db.insert(userIdentities).values({
      tenant_id: state.ctx.tenantId,
      user_id: user.id,
      provider_id: "testapp-supabase",
      issuer_url: "https://auth.example.test/auth/v1",
      product_id: "testapp",
      subject,
      email: `testapp-supabase:${subject}@invalid`,
    });
    return {
      provider: "testapp-supabase",
      kind: "user",
      id: user.id,
      tenant_id: state.ctx.tenantId,
      roles: ["member"],
      product_id: "testapp",
      subject,
    };
  }

  function admit(
    principal: ResolvedPrincipal,
    input: Record<string, unknown>,
    workflow_id = state.roundWorkflow,
    idempotency_key?: string,
  ) {
    return admitWorkflowRun(
      {
        tenant_id: state.ctx.tenantId,
        workflow_id,
        execution_environment: "dev",
        request_source: "api",
        hold_writes: true,
        input,
        ...(idempotency_key ? { idempotency_key } : {}),
      },
      state.ctx.testDb.db,
      principal,
    );
  }

  async function unit(principal: ResolvedPrincipal, turn: string) {
    const [row] = await state.ctx.testDb.db
      .select()
      .from(callerBudgetUnits)
      .where(
        and(
          eq(callerBudgetUnits.tenant_id, state.ctx.tenantId),
          eq(callerBudgetUnits.principal_id, principal.id),
          eq(callerBudgetUnits.unit_key, turn),
        ),
      );
    return row;
  }

  return { admit, productUser, unit };
}
