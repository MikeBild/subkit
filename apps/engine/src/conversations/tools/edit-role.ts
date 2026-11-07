import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  BuiltinImmutableError,
  getRole,
  grantPermissionToRole,
  listRolePermissions,
  PermissionNotFoundError,
  RoleNameReservedError,
  RoleNameTakenError,
  RoleNotFoundError,
  revokePermissionFromRole,
  updateRole,
} from "../../rbac/roles.ts";
import { auditActorFromToolContext } from "./audit-actor.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    role_id: z.string().uuid(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(1000).nullable().optional(),
    permissions: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Full replacement permission list. Diff vs. current is applied: missing → revoked, added → granted.",
      ),
    add_permissions: z.array(z.string().min(1)).optional(),
    remove_permissions: z.array(z.string().min(1)).optional(),
  })
  .openapi("EditRoleToolInput");

export const editRoleTool: ConversationTool = {
  name: "edit_role",
  description:
    "Patch a role's metadata + permission set. Either replace the full permission list (`permissions`) OR nudge with `add_permissions` / `remove_permissions`. Built-in roles are rejected.",
  use_case:
    "Granting a new permission to a role, renaming a role, or replacing the entire permission set after a policy redesign.",
  important_notes: [
    "Built-in roles (`is_builtin=true`) cannot be edited; create a new role and assign users instead.",
    "Use `permissions` for full-list replacement; use `add_permissions` / `remove_permissions` for targeted nudges.",
    "Validate any custom rule expression with `test_rbac_expression` (mode=expression_preview) BEFORE saving.",
    "Confirmation gate: this writes RBAC state — tenant_write policy fires confirm_before_execution.",
  ],
  inputSchema,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const metadataPatch: Parameters<typeof updateRole>[3] = {};
    if (args.name !== undefined) metadataPatch.name = args.name;
    if (args.description !== undefined) metadataPatch.description = args.description;

    try {
      const role = await getRole(ctx.db, ctx.tenant_id, args.role_id);
      if (!role) throw new RoleNotFoundError();
      if (role.is_builtin) throw new BuiltinImmutableError();
      if (Object.keys(metadataPatch).length > 0) {
        await updateRole(ctx.db, ctx.tenant_id, args.role_id, metadataPatch);
      }

      const current = new Set(await listRolePermissions(ctx.db, ctx.tenant_id, args.role_id));
      const granted: string[] = [];
      const revoked: string[] = [];
      if (args.permissions) {
        const desired = new Set(args.permissions);
        for (const p of desired) {
          if (!current.has(p)) {
            await grantPermissionToRole(ctx.db, ctx.tenant_id, args.role_id, p);
            granted.push(p);
          }
        }
        for (const p of current) {
          if (!desired.has(p)) {
            await revokePermissionFromRole(ctx.db, ctx.tenant_id, args.role_id, p);
            revoked.push(p);
          }
        }
      } else {
        for (const p of args.add_permissions ?? []) {
          if (!current.has(p)) {
            await grantPermissionToRole(ctx.db, ctx.tenant_id, args.role_id, p);
            granted.push(p);
          }
        }
        for (const p of args.remove_permissions ?? []) {
          if (current.has(p)) {
            await revokePermissionFromRole(ctx.db, ctx.tenant_id, args.role_id, p);
            revoked.push(p);
          }
        }
      }

      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          action: AuditAction.RBAC_ROLE_UPDATED,
          resource_type: "role",
          resource_id: args.role_id,
          result: "success",
          metadata: {
            conversation_id: ctx.conversation_id,
            metadata_patched: Object.keys(metadataPatch),
            granted,
            revoked,
          },
        },
        ctx.db,
      );

      const finalPerms = await listRolePermissions(ctx.db, ctx.tenant_id, args.role_id);
      return {
        ok: true,
        data: {
          role_id: args.role_id,
          metadata_patched: Object.keys(metadataPatch),
          granted,
          revoked,
          permissions: finalPerms,
          persistence: "saved" as const,
        },
      };
    } catch (err) {
      if (err instanceof BuiltinImmutableError) {
        return {
          ok: false,
          error_code: "builtin_immutable",
          message: "this role is built-in and cannot be edited. Create a custom role instead.",
          next_best_actions: ["find_role", "inspect_role"],
        };
      }
      if (err instanceof RoleNameReservedError) {
        return {
          ok: false,
          error_code: "role_name_reserved",
          message: "this name belongs to a built-in role. Choose a different name.",
          next_best_actions: ["find_role"],
        };
      }
      if (err instanceof RoleNameTakenError) {
        return {
          ok: false,
          error_code: "role_name_taken",
          message: "another role of this workspace already has this name. Choose a different name.",
          next_best_actions: ["find_role"],
        };
      }
      if (err instanceof RoleNotFoundError) {
        return {
          ok: false,
          error_code: "role_not_found",
          message: `no role with id \`${args.role_id}\``,
          next_best_actions: ["find_role"],
        };
      }
      if (err instanceof PermissionNotFoundError) {
        return {
          ok: false,
          error_code: "permission_unknown",
          message: err.message,
          next_best_actions: ["find_role", "inspect_role"],
        };
      }
      throw err;
    }
  },
};
