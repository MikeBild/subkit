import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actorOfPrincipal, isRejection, type OperationScope } from "../../api/operations/index.ts";
import { getVaultItemOperation, listVaultItemsOperation } from "../../api/operations/vault.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { ToolEnvelope } from "../../tools/types.ts";
import { zodToJsonSchema7 } from "../json-schema.ts";

const ListVaultItemsInput = z
  .object({
    scope: z.enum(["workspace", "person"]).optional(),
    kind: z.enum(["connector", "secret", "login", "template_client"]).optional(),
  })
  .strict();

const GetVaultItemInput = z.object({ id: z.string().uuid() }).strict();

const NEVER_VALUES =
  "Values are never returned: a workflow step names an item as ${secret.<name>} (or ${secret.me.<name>} for your own items) and SubKit injects the value only while an approved run executes.";

export const listVaultItemsMcpTool: Tool = {
  name: "list_vault_items",
  description: `List the vault items you may see, as GET /v1/vault returns them: name (the handle), kind (connector, secret, login, template_client), scope (workspace or person), environment, version, the connector an item belongs to, fields, rotated_at and last_used_at. ${NEVER_VALUES}`,
  inputSchema: zodToJsonSchema7(ListVaultItemsInput) as Tool["inputSchema"],
  annotations: {
    title: "Vault items",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const getVaultItemMcpTool: Tool = {
  name: "get_vault_item",
  description: `Read one vault item's metadata by id, as GET /v1/vault/{id} returns it. ${NEVER_VALUES}`,
  inputSchema: zodToJsonSchema7(GetVaultItemInput) as Tool["inputSchema"],
  annotations: {
    title: "Vault item",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function scopeOf(ctx: { db: Db; principal: ResolvedPrincipal }): OperationScope {
  return {
    db: ctx.db,
    tenant_id: ctx.principal.tenant_id,
    principal: ctx.principal,
    actor: actorOfPrincipal(ctx.principal),
  };
}

export async function invokeListVaultItems(
  ctx: { db: Db; principal: ResolvedPrincipal },
  args: unknown,
): Promise<ToolEnvelope> {
  const parsed = ListVaultItemsInput.safeParse(args ?? {});
  if (!parsed.success) {
    return { status: "error", error_code: "invalid_args", message: parsed.error.message };
  }
  const scope = scopeOf(ctx);
  const outcome = await listVaultItemsOperation.handler(scope, {
    ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
    ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
  });
  if (isRejection(outcome)) {
    return { status: "error", error_code: outcome.code, message: outcome.message };
  }
  return { status: "ok", data: outcome };
}

export async function invokeGetVaultItem(
  ctx: { db: Db; principal: ResolvedPrincipal },
  args: unknown,
): Promise<ToolEnvelope> {
  const parsed = GetVaultItemInput.safeParse(args ?? {});
  if (!parsed.success) {
    return { status: "error", error_code: "invalid_args", message: parsed.error.message };
  }
  const outcome = await getVaultItemOperation.handler(scopeOf(ctx), { id: parsed.data.id });
  if (isRejection(outcome)) {
    return { status: "error", error_code: outcome.code, message: outcome.message };
  }
  return { status: "ok", data: outcome };
}
