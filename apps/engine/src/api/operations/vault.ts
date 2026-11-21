import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  createVaultItem,
  deleteVaultItem,
  getVaultItem,
  listVaultItems,
  normalizeItemName,
  revealVaultItem,
  updateVaultItem,
  type VaultActivityEntry,
  VaultError,
  type VaultItemView,
  vaultItemActivity,
  vaultValueOf,
  vaultViewer,
} from "../../vault/index.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["vault"] as const;

const VaultItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(["connector", "secret", "login", "template_client"]),
    scope: z.enum(["workspace", "person"]),
    environment: z.enum(["dev", "prod"]),
    description: z.string().nullable(),
    version: z.number().int().positive(),
    connector: z
      .object({ id: z.string().uuid(), slug: z.string(), display_name: z.string() })
      .nullable(),
    template_slug: z.string().nullable(),
    fields: z.array(z.string()),
    created_at: z.string(),
    updated_at: z.string(),
    rotated_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
  })
  .openapi("VaultItem");

const VaultItemListSchema = z
  .object({ items: z.array(VaultItemSchema) })
  .openapi("VaultItemListResponse");

const VaultListQuery = z.object({
  scope: z.enum(["workspace", "person"]).optional(),
  kind: z.enum(["connector", "secret", "login", "template_client"]).optional(),
});

const VaultValueFields = {
  token: z.string().min(1).max(16384).optional().describe("Secret value. Never returned."),
  username: z.string().min(1).max(1024).optional(),
  password: z.string().min(1).max(16384).optional().describe("Secret value. Never returned."),
};

const VaultCreateBody = z
  .object({
    kind: z.enum(["secret", "login"]),
    name: z.string().min(1).max(63),
    scope: z.enum(["workspace", "person"]).default("workspace"),
    environment: z.enum(["dev", "prod"]).default("prod"),
    description: z.string().max(500).nullable().optional(),
    ...VaultValueFields,
  })
  .strict()
  .openapi("VaultItemCreate");

const VaultUpdateBody = z
  .object({
    description: z.string().max(500).nullable().optional(),
    ...VaultValueFields,
  })
  .strict()
  .openapi("VaultItemUpdate");

const VaultRevealSchema = z
  .object({ id: z.string().uuid(), name: z.string(), values: z.record(z.string(), z.string()) })
  .openapi("VaultItemReveal");

const VaultActivitySchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        at: z.string(),
        action: z.string(),
        actor_type: z.string(),
        actor_id: z.string().nullable(),
        result: z.string(),
        metadata: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .openapi("VaultItemActivity");

type CreateInput = z.infer<typeof VaultCreateBody>;
type UpdateInput = { readonly id: string } & z.infer<typeof VaultUpdateBody>;

function asRejection(error: unknown): Rejection {
  if (!(error instanceof VaultError)) throw error;
  switch (error.code) {
    case "not_found":
      return reject.notFound("vault item");
    case "forbidden":
      return reject.forbidden(error.message);
    case "conflict":
      return reject.conflict(error.message, undefined, "vault_item_exists");
    case "unreadable":
      return reject.unprocessable(error.message, undefined, "vault_item_unreadable");
    case "invalid":
      return reject.badRequest(error.message);
  }
}

async function withViewer<T>(
  scope: OperationScope,
  work: (viewer: Awaited<ReturnType<typeof vaultViewer>>) => Promise<T>,
): Promise<T | Rejection> {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  try {
    return await work(await vaultViewer(scope.db, principal));
  } catch (error) {
    return asRejection(error);
  }
}

function actor(scope: OperationScope) {
  return scope.principal ? actorOf(scope.principal) : null;
}

export const listVaultItemsOperation = defineOperation<
  z.infer<typeof VaultListQuery>,
  { items: VaultItemView[] }
>({
  id: "vault.item.list",
  summary: "List vault items: names and metadata only, never values",
  permission: null,
  effect: "read",
  handler: (scope, query) =>
    withViewer(scope, async (viewer) => ({
      items: await listVaultItems(scope.db, scope.tenant_id, viewer, query),
    })),
  http: {
    method: "get",
    path: "/v1/vault",
    tags: TAGS,
    query: VaultListQuery,
    response: VaultItemListSchema,
    toInput: ({ query }) => query as z.infer<typeof VaultListQuery>,
    toBody: (result) => result,
  },
});

export const getVaultItemOperation = defineOperation<{ readonly id: string }, VaultItemView>({
  id: "vault.item.get",
  summary: "Read one vault item's metadata, never its value",
  permission: null,
  effect: "read",
  handler: (scope, { id }) =>
    withViewer(scope, (viewer) => getVaultItem(scope.db, scope.tenant_id, id, viewer)),
  http: {
    method: "get",
    path: "/v1/vault/{id}",
    tags: TAGS,
    params: IdParam,
    response: VaultItemSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (result) => result,
  },
});

export const createVaultItemOperation = defineOperation<CreateInput, VaultItemView>({
  id: "vault.item.create",
  summary: "Add a secret or a login to the vault",
  permission: null,
  effect: "write",
  audit: AuditAction.VAULT_ITEM_CREATED,
  handler: (scope, body) => {
    const name = normalizeItemName(body.name);
    if (!name) {
      return Promise.resolve(
        reject.badRequest(
          "use lowercase letters, digits, dashes or underscores, starting with a letter or digit",
        ),
      );
    }
    const value = vaultValueOf(body.kind, body);
    if (typeof value === "string") return Promise.resolve(reject.badRequest(value));
    return withViewer(scope, (viewer) =>
      createVaultItem(scope.db, {
        tenant_id: scope.tenant_id,
        actor: actor(scope),
        viewer,
        kind: body.kind,
        name,
        scope: body.scope,
        environment: body.environment,
        description: body.description ?? null,
        value,
      }),
    );
  },
  http: {
    method: "post",
    path: "/v1/vault",
    tags: TAGS,
    body: VaultCreateBody,
    bodyRequired: true,
    response: VaultItemSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request", 403: "Forbidden", 409: "Name taken" },
    toInput: ({ json }) => json as CreateInput,
    toBody: (result) => result,
  },
});

export const updateVaultItemOperation = defineOperation<UpdateInput, VaultItemView>({
  id: "vault.item.update",
  summary: "Change a vault item's description or replace its value (rotation)",
  permission: null,
  effect: "write",
  audit: AuditAction.VAULT_ITEM_ROTATED,
  handler: (scope, body) =>
    withViewer(scope, async (viewer) => {
      const current = await getVaultItem(scope.db, scope.tenant_id, body.id, viewer);
      const rotates =
        body.token !== undefined || body.username !== undefined || body.password !== undefined;
      let value: ReturnType<typeof vaultValueOf> | undefined;
      if (rotates) {
        if (current.kind !== "secret" && current.kind !== "login") {
          throw new VaultError("forbidden", "change this item on its connector");
        }
        value = vaultValueOf(current.kind, body);
        if (typeof value === "string") throw new VaultError("invalid", value);
      }
      return updateVaultItem(scope.db, {
        tenant_id: scope.tenant_id,
        id: body.id,
        actor: actor(scope),
        viewer,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(value && typeof value !== "string" ? { value } : {}),
      });
    }),
  http: {
    method: "patch",
    path: "/v1/vault/{id}",
    tags: TAGS,
    params: IdParam,
    body: VaultUpdateBody,
    bodyRequired: true,
    response: VaultItemSchema,
    errors: { 400: "Bad request", 403: "Forbidden", 404: "Not found" },
    toInput: ({ param, json }) => ({
      ...(json as z.infer<typeof VaultUpdateBody>),
      id: (param as { id: string }).id,
    }),
    toBody: (result) => result,
  },
});

export const deleteVaultItemOperation = defineOperation<{ readonly id: string }, null>({
  id: "vault.item.delete",
  summary: "Delete a vault item and its value",
  permission: null,
  effect: "write",
  audit: AuditAction.VAULT_ITEM_DELETED,
  handler: (scope, { id }) =>
    withViewer(scope, async (viewer) => {
      await deleteVaultItem(scope.db, {
        tenant_id: scope.tenant_id,
        id,
        actor: actor(scope),
        viewer,
      });
      return null;
    }),
  http: {
    method: "delete",
    path: "/v1/vault/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted", empty: true },
    errors: { 403: "Forbidden", 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: () => null,
  },
});

export const revealVaultItemOperation = defineOperation<
  { readonly id: string },
  { id: string; name: string; values: Record<string, string> }
>({
  id: "vault.item.reveal",
  summary: "Reveal a vault item's value to the person who asks; every reveal is audited",
  permission: null,
  effect: "write",
  audit: AuditAction.VAULT_ITEM_REVEALED,
  handler: (scope, { id }) =>
    withViewer(scope, (viewer) =>
      revealVaultItem(scope.db, { tenant_id: scope.tenant_id, id, actor: actor(scope), viewer }),
    ),
  http: {
    method: "post",
    path: "/v1/vault/{id}/reveal",
    tags: TAGS,
    params: IdParam,
    response: VaultRevealSchema,
    errors: { 403: "Forbidden", 404: "Not found", 422: "Unreadable" },
    responseHeaders: () => ({ "Cache-Control": "no-store" }),
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (result) => result,
  },
});

export const vaultItemActivityOperation = defineOperation<
  { readonly id: string },
  { items: VaultActivityEntry[] }
>({
  id: "vault.item.activity",
  summary: "List what happened to a vault item: created, used, revealed, rotated",
  permission: null,
  effect: "read",
  handler: (scope, { id }) =>
    withViewer(scope, async (viewer) => ({
      items: await vaultItemActivity(scope.db, { tenant_id: scope.tenant_id, id, viewer }),
    })),
  http: {
    method: "get",
    path: "/v1/vault/{id}/activity",
    tags: TAGS,
    params: IdParam,
    response: VaultActivitySchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (result) => result,
  },
});
