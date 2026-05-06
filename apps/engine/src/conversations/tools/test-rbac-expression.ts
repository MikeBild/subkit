// test_rbac_expression — conversational RBAC probe.
//
// Answers "would actor X be allowed to do Y on resource Z?" without
// mutating state. Reuses the same `rbac/evaluator.ts:can` the HTTP
// layer uses, so the answer is authoritative — no drift between the
// conversational surface and real enforcement.
//
// Input:
//   { actor_id: uuid, actor_kind: "user" | "system_account",
//     permission: "workflow.run", resource_id?: uuid,
//     resource_type?: "workflow" | "connector" | ... }
//
// Output: `{ allow, reason, source }` — the same Decision shape the
// evaluator returns for real requests.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { roles, systemAccounts, users } from "../../db/schema/index.ts";
import { compile as compileJsonata } from "../../execution/jsonata-engine.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ConversationTool } from "./index.ts";

// Two input shapes selected by `mode`:
//   1. `actor_probe` (default) — "would actor X have permission P on
//      resource R?" Reuses the live RBAC evaluator. Authoritative —
//      no drift.
//   2. `expression_preview` — "would this JSONata predicate
//      evaluate to true against this sample step config?" Mirrors
//      the reference impl's `test_role_access` shape so the LLM can
//      validate a proposed custom rule before saving it.
//
// IMPORTANT: must be a flat z.object (NOT z.union / z.discriminatedUnion).
// Anthropic's tool-use contract requires `input_schema.type: "object"`
// at the root; a Zod union serialises to `anyOf` with no top-level
// `type` and the API rejects the whole turn with
// `tools.N.custom.input_schema.type: Field required`.
const Input = z
  .object({
    mode: z.enum(["actor_probe", "expression_preview"]).default("actor_probe"),
    // actor_probe fields
    actor_id: z.string().uuid().optional(),
    actor_kind: z.enum(["user", "system_account"]).optional(),
    permission: z.string().min(1).optional(),
    resource_id: z.string().uuid().optional(),
    resource_type: z.string().optional(),
    // expression_preview fields
    expression: z
      .string()
      .min(1)
      .optional()
      .describe(
        "JSONata predicate (mode=expression_preview). Bound: $config = the step config under test. Truthy result → allow.",
      ),
    step_config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Sample step configuration (mode=expression_preview) the predicate is evaluated against.",
      ),
  })
  .openapi("TestRbacExpressionToolInput");

export const testRbacExpressionTool: ConversationTool = {
  name: "test_rbac_expression",
  description:
    "Check whether a specific actor would be allowed to perform a given permission, optionally against a named resource. Pure probe — writes nothing. Useful for answering 'would user X be able to approve patch candidate Y?' before granting a role.",
  inputSchema: Input,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);

    // Expression-preview mode: stateless JSONata evaluation. Useful
    // BEFORE saving a custom rule via edit_role — the LLM can show
    // the operator what the predicate matches against a sample step
    // config so they don't accidentally lock themselves out.
    if (args.mode === "expression_preview") {
      if (!args.expression || !args.step_config) {
        return {
          ok: false,
          data: {
            error: "missing_required_fields",
            message: "mode=expression_preview requires both `expression` and `step_config`.",
          },
        };
      }
      try {
        // Bespoke binding: `$config` exposes the step config under test.
        // Doesn't fit the engine's standard `EvalBindings` shape, so go
        // through `compileJsonata` for the cache + structured errors,
        // then evaluate directly with the bespoke binding.
        const expr = compileJsonata(args.expression);
        const result = await expr.evaluate(args.step_config, {
          config: args.step_config,
        });
        return {
          ok: true,
          data: {
            mode: "expression_preview",
            expression: args.expression,
            allow: !!result,
            raw_result: result ?? null,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error_code: "expression_invalid",
          message: err instanceof Error ? err.message : String(err),
          details: { expression: args.expression },
        };
      }
    }

    // actor_probe mode requires actor_id + permission.
    if (!args.actor_id || !args.permission) {
      return {
        ok: false,
        data: {
          error: "missing_required_fields",
          message: "mode=actor_probe requires both `actor_id` and `permission`.",
        },
      };
    }
    const actor_kind = args.actor_kind ?? "user";

    // Resolve the actor's role names from their tenant row. Users and
    // system_accounts both carry a legacy enum role + an optional
    // `role_id` pointer. We prefer the named role when present and fall
    // back to the enum so the probe works on legacy rows too.
    let actorRoles: string[] = [];
    let actorExists = false;
    if (actor_kind === "user") {
      const rows = await ctx.db
        .select({ role: users.role, role_id: users.role_id })
        .from(users)
        .where(and(eq(users.id, args.actor_id), eq(users.tenant_id, ctx.tenant_id)))
        .limit(1);
      if (rows[0]) {
        actorExists = true;
        if (rows[0].role_id) {
          // tenant-filter:exempt — RBAC catalog walk by role_id; handles both global rows (tenant_id IS NULL) and tenant rows
          const named = await ctx.db
            .select({ name: roles.name })
            .from(roles)
            .where(eq(roles.id, rows[0].role_id))
            .limit(1);
          actorRoles = named[0] ? [named[0].name] : [rows[0].role];
        } else {
          actorRoles = [rows[0].role];
        }
      }
    } else {
      const rows = await ctx.db
        .select({ role_id: systemAccounts.role_id })
        .from(systemAccounts)
        .where(
          and(eq(systemAccounts.id, args.actor_id), eq(systemAccounts.tenant_id, ctx.tenant_id)),
        )
        .limit(1);
      if (rows[0]) {
        actorExists = true;
        if (rows[0].role_id) {
          // tenant-filter:exempt — RBAC catalog walk by role_id; handles both global rows (tenant_id IS NULL) and tenant rows
          const named = await ctx.db
            .select({ name: roles.name })
            .from(roles)
            .where(eq(roles.id, rows[0].role_id))
            .limit(1);
          actorRoles = named[0] ? [named[0].name] : ["member"];
        } else {
          actorRoles = ["member"];
        }
      }
    }
    if (!actorExists) {
      return {
        ok: false,
        data: { error: "actor_not_found_in_tenant", actor_id: args.actor_id },
      };
    }

    const principal: ResolvedPrincipal = {
      provider: "rbac_probe",
      kind: actor_kind,
      id: args.actor_id,
      tenant_id: ctx.tenant_id,
      roles: actorRoles,
    };

    const check: Parameters<typeof can>[1] = {
      tenant_id: ctx.tenant_id,
      principal,
      permission: args.permission,
      ...(args.resource_id && args.resource_type
        ? { resource: { type: args.resource_type, id: args.resource_id } }
        : {}),
    };

    const decision = await can(ctx.db, check);
    return {
      ok: true,
      data: {
        actor_id: args.actor_id,
        actor_kind: actor_kind,
        roles: actorRoles,
        permission: args.permission,
        ...(args.resource_id && args.resource_type
          ? { resource: { type: args.resource_type, id: args.resource_id } }
          : {}),
        allow: decision.allow,
        reason: decision.reason ?? null,
        source: decision.source ?? null,
      },
    };
  },
};
