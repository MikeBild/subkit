import { z } from "@hono/zod-openapi";
import { VAULT_ENTRY_KINDS, VAULT_KINDS } from "@shared/vault-kinds.ts";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  createVaultItem,
  deleteVaultItem,
  getVaultItem,
  importVaultLogins,
  listVaultItems,
  normalizeItemName,
  parseKindValue,
  revealVaultItem,
  sessionAuthTime,
  updateVaultItem,
  type VaultActivityEntry,
  VaultError,
  type VaultImportResult,
  type VaultItemView,
  type VaultLoginPatch,
  type VaultValue,
  vaultItemActivity,
  vaultViewer,
} from "../../vault/index.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["vault"] as const;

const VaultItemMetadataSchema = z
  .object({
    username_hint: z.string(),
    has_totp: z.boolean(),
    brand: z.string(),
    last4: z.string(),
    exp_month: z.number().int(),
    exp_year: z.number().int(),
    iban_last4: z.string(),
    country: z.string(),
    label_hint: z.string(),
    city: z.string(),
  })
  .partial()
  .describe(
    "Public metadata of the item, safe to show and to give to models: login username_hint and has_totp, card brand, last4 and expiry, bank account iban_last4 and country, identity label_hint, address city and country",
  )
  .openapi("VaultItemMetadata");

const VaultItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(VAULT_KINDS),
    scope: z.enum(["workspace", "person"]),
    environment: z.enum(["dev", "prod"]),
    description: z.string().nullable(),
    version: z.number().int().positive(),
    connector: z
      .object({ id: z.string().uuid(), slug: z.string(), display_name: z.string() })
      .nullable(),
    template_slug: z.string().nullable(),
    fields: z.array(z.string()),
    metadata: VaultItemMetadataSchema,
    origins: z.array(z.string()),
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
  kind: z.enum(VAULT_KINDS).optional(),
});

const VaultValueFields = {
  token: z.string().min(1).max(16384).optional().describe("Secret value. Never returned."),
  username: z.string().min(1).max(1024).optional(),
  password: z.string().min(1).max(16384).optional().describe("Secret value. Never returned."),
  totp_seed: z
    .string()
    .max(2048)
    .nullable()
    .optional()
    .describe(
      "login: the one-time code key as a base32 seed or an otpauth:// link; null removes it. Never returned.",
    ),
  origins: z
    .array(z.string().max(2048))
    .max(20)
    .optional()
    .describe("login: the websites (https origins) this login may be used on"),
  value: z
    .record(z.string(), z.union([z.string().max(20000), z.number()]))
    .optional()
    .describe(
      "card, bank_account, identity, address or note: the structured value. A card never takes its security code. Never returned.",
    ),
};

const VaultCreateBody = z
  .object({
    kind: z.enum(VAULT_ENTRY_KINDS),
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

const VaultImportBody = z
  .object({
    csv: z.string().min(1).max(5_000_000).describe("The exported CSV file as text"),
    format: z.enum(["chrome", "1password", "bitwarden"]).optional(),
    scope: z.enum(["workspace", "person"]).default("person"),
    environment: z.enum(["dev", "prod"]).default("prod"),
    dry_run: z.boolean().default(true),
  })
  .strict()
  .openapi("VaultImport");

const VaultImportResultSchema = z
  .object({
    dry_run: z.boolean(),
    format: z.enum(["chrome", "1password", "bitwarden"]),
    rows: z.array(
      z.object({
        row: z.number().int(),
        name: z.string(),
        status: z.enum(["create", "created", "exists", "invalid"]),
        origin: z.string().nullable(),
        username_hint: z.string().nullable(),
        has_totp: z.boolean(),
        reason: z.string().nullable(),
      }),
    ),
    created: z.number().int(),
    skipped: z.number().int(),
    invalid: z.number().int(),
  })
  .openapi("VaultImportResult");

type CreateInput = z.infer<typeof VaultCreateBody>;
type UpdateInput = { readonly id: string } & z.infer<typeof VaultUpdateBody>;
type ImportInput = z.infer<typeof VaultImportBody>;

type ValueFields = Pick<CreateInput, "token" | "username" | "password" | "totp_seed" | "value">;

function createValueOf(kind: CreateInput["kind"], body: ValueFields): VaultValue | string {
  if (kind === "secret") return parsedValue(kind, { token: body.token });
  if (kind === "login") {
    return parsedValue(kind, {
      username: body.username,
      password: body.password,
      totp_seed: body.totp_seed ?? undefined,
    });
  }
  if (body.token !== undefined || body.username !== undefined || body.password !== undefined) {
    return `a ${kind} takes its fields in value`;
  }
  return parsedValue(kind, body.value ?? {});
}

function parsedValue(kind: string, raw: Record<string, unknown>): VaultValue | string {
  const parsed = parseKindValue(kind, raw, new Date());
  return parsed.ok ? parsed.value : parsed.message;
}

function rotationOf(
  kind: string,
  body: ValueFields,
): VaultValue | VaultLoginPatch | string | undefined {
  const touched =
    body.token !== undefined ||
    body.username !== undefined ||
    body.password !== undefined ||
    body.totp_seed !== undefined ||
    body.value !== undefined;
  if (!touched) return undefined;
  if (kind === "login") {
    if (body.username === "" || body.password === "")
      return "a login needs a username and a password";
    let totp_seed: string | null | undefined = body.totp_seed;
    if (typeof totp_seed === "string" && totp_seed.trim() !== "") {
      const checked = parsedValue("login", { username: "x", password: "x", totp_seed });
      if (typeof checked === "string") return checked;
      totp_seed = checked.kind === "login" ? (checked.totp_seed ?? null) : null;
    } else if (typeof totp_seed === "string") {
      totp_seed = null;
    }
    return {
      kind: "login_patch",
      ...(body.username !== undefined ? { username: body.username } : {}),
      ...(body.password !== undefined ? { password: body.password } : {}),
      ...(totp_seed !== undefined ? { totp_seed } : {}),
    };
  }
  if (kind === "secret") return parsedValue(kind, { token: body.token });
  return createValueOf(kind as CreateInput["kind"], body);
}

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
    case "reauth_required":
      return reject.forbidden(error.message, {
        reason: "reauthentication_required",
        max_age_seconds: 300,
      });
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
  summary:
    "Add a secret, login, card, bank account, identity, address or note to the vault; cards, bank accounts and identities are personal only",
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
    const value = createValueOf(body.kind, body);
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
        ...(body.origins ? { origins: body.origins } : {}),
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
      if (current.kind === "connector" || current.kind === "template_client") {
        if (rotationOf("secret", body) !== undefined || body.origins !== undefined) {
          throw new VaultError("forbidden", "change this item on its connector");
        }
      }
      const value =
        current.kind === "connector" || current.kind === "template_client"
          ? undefined
          : rotationOf(current.kind, body);
      if (typeof value === "string") throw new VaultError("invalid", value);
      return updateVaultItem(scope.db, {
        tenant_id: scope.tenant_id,
        id: body.id,
        actor: actor(scope),
        viewer,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(value ? { value } : {}),
        ...(body.origins !== undefined ? { origins: body.origins } : {}),
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
    withViewer(scope, async (viewer) =>
      revealVaultItem(scope.db, {
        tenant_id: scope.tenant_id,
        id,
        actor: actor(scope),
        viewer,
        auth_time: scope.principal ? await sessionAuthTime(scope.db, scope.principal) : null,
      }),
    ),
  http: {
    method: "post",
    path: "/v1/vault/{id}/reveal",
    tags: TAGS,
    params: IdParam,
    response: VaultRevealSchema,
    errors: {
      403: "Forbidden, or a card or bank account needs a sign-in younger than 5 minutes (details.reason reauthentication_required)",
      404: "Not found",
      422: "Unreadable",
    },
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

export const importVaultLoginsOperation = defineOperation<ImportInput, VaultImportResult>({
  id: "vault.item.import",
  summary:
    "Import logins from a Chrome, 1Password or Bitwarden CSV export, with one-time code keys; dry_run (the default) only shows what would happen",
  permission: null,
  effect: "write",
  audit: AuditAction.VAULT_ITEM_CREATED,
  handler: (scope, body) =>
    withViewer(scope, (viewer) =>
      importVaultLogins(scope.db, {
        tenant_id: scope.tenant_id,
        actor: actor(scope),
        viewer,
        csv: body.csv,
        ...(body.format ? { format: body.format } : {}),
        scope: body.scope,
        environment: body.environment,
        dry_run: body.dry_run,
      }),
    ),
  http: {
    method: "post",
    path: "/v1/vault/import",
    tags: TAGS,
    body: VaultImportBody,
    bodyRequired: true,
    response: VaultImportResultSchema,
    errors: { 400: "Bad request", 403: "Forbidden" },
    responseHeaders: () => ({ "Cache-Control": "no-store" }),
    toInput: ({ json }) => json as ImportInput,
    toBody: (result) => result,
  },
});
