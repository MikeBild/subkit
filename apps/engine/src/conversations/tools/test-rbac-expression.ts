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
import { can } from "../../rbac/evaluator.ts";
import type { ConversationTool } from "./index.ts";

const Input = z
  .object({
    actor_id: z.string().uuid(),
    actor_kind: z.enum(["user", "system_account"]).default("user"),
    permission: z.string().min(1),
    resource_id: z.string().uuid().optional(),
    resource_type: z.string().optional(),
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

    // Resolve the actor's role names from their tenant row. Users and
    // system_accounts both carry a legacy enum role + an optional
    // `role_id` pointer. We prefer the named role when present and fall
    // back to the enum so the probe works on legacy rows too.
    let actorRoles: string[] = [];
    let actorExists = false;
    if (args.actor_kind === "user") {
      const rows = await ctx.db
        .select({ role: users.role, role_id: users.role_id })
        .from(users)
        .where(and(eq(users.id, args.actor_id), eq(users.tenant_id, ctx.tenant_id)))
        .limit(1);
      if (rows[0]) {
        actorExists = true;
        if (rows[0].role_id) {
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
      kind: args.actor_kind,
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
        actor_kind: args.actor_kind,
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
