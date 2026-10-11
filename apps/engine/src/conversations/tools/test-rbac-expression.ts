import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { roles, systemAccounts, users } from "../../db/schema/index.ts";
import { evaluate as evaluateJsonata } from "../../execution/jsonata-engine.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ConversationTool } from "./index.ts";

const Input = z
  .object({
    mode: z.enum(["actor_probe", "expression_preview"]).default("actor_probe"),
    actor_id: z.string().uuid().optional(),
    actor_kind: z.enum(["user", "system_account"]).optional(),
    permission: z.string().min(1).optional(),
    resource_id: z.string().uuid().optional(),
    resource_type: z.string().optional(),
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
  authoring_only: true,
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);

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
        const result = await evaluateJsonata(args.expression, args.step_config, {
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

    let actorRoles: string[] = [];
    let actorExists = false;
    if (actor_kind === "user") {
      const rows = await ctx.db
        .select({ role_name: roles.name })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.role_id))
        .where(and(eq(users.id, args.actor_id), eq(users.tenant_id, ctx.tenant_id)))
        .limit(1);
      if (rows[0]) {
        actorExists = true;
        actorRoles = rows[0].role_name ? [rows[0].role_name] : [];
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
