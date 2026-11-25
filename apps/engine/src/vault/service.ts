import { randomUUID } from "node:crypto";
import type { VaultField, VaultHandle } from "@shared/vault-handle.ts";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Actor } from "../audit/actor.ts";
import { auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActionValue } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { deserializePlain, serializePlain } from "../credentials/credential-value.ts";
import { deleteCredential } from "../credentials/service.ts";
import { decryptSecret, encryptSecret } from "../crypto/index.ts";
import type { Executor } from "../db/client.ts";
import { type ScopedTx, withTenantScope } from "../db/index.ts";
import { auditLog, connectors, vaultItems } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import { can } from "../rbac/evaluator.ts";
import {
  type PreparedVaultValue,
  type PreparedVaultValues,
  vaultValueKey,
} from "./core/injection.ts";
import {
  handleMatches,
  isEditableKind,
  mergedLoginValue,
  VAULT_PERMISSION,
  type VaultAction,
  type VaultEntryKind,
  type VaultEnvironment,
  type VaultItemKind,
  type VaultLoginPatch,
  type VaultValue,
  type VaultViewer,
  vaultAccess,
  vaultFieldValue,
  vaultScopeOf,
  vaultSecretsOf,
} from "./core/vault-item.ts";

export interface VaultItemView {
  id: string;
  name: string;
  kind: VaultItemKind;
  scope: "workspace" | "person";
  environment: VaultEnvironment;
  description: string | null;
  version: number;
  connector: { id: string; slug: string; display_name: string } | null;
  template_slug: string | null;
  fields: string[];
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
}

export interface VaultActivityEntry {
  id: string;
  at: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  result: string;
  metadata: Record<string, unknown>;
}

export class VaultError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict" | "invalid" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

const COLUMNS = {
  id: vaultItems.id,
  tenant_id: vaultItems.tenant_id,
  name: vaultItems.name,
  kind: vaultItems.kind,
  owner_user_id: vaultItems.owner_user_id,
  environment: vaultItems.environment,
  mode: vaultItems.mode,
  description: vaultItems.description,
  credential_generation: vaultItems.credential_generation,
  template_slug: vaultItems.template_slug,
  connector_id: vaultItems.connector_id,
  connector_slug: connectors.slug,
  connector_display_name: connectors.display_name,
  created_at: vaultItems.created_at,
  updated_at: vaultItems.updated_at,
  rotated_at: vaultItems.rotated_at,
  last_used_at: vaultItems.last_used_at,
};

type ItemRow = {
  id: string;
  tenant_id: string;
  name: string;
  kind: VaultItemKind;
  owner_user_id: string | null;
  environment: VaultEnvironment;
  mode: string;
  description: string | null;
  credential_generation: number;
  template_slug: string | null;
  connector_id: string | null;
  connector_slug: string | null;
  connector_display_name: string | null;
  created_at: Date;
  updated_at: Date;
  rotated_at: Date | null;
  last_used_at: Date | null;
};

const FIELDS_BY_MODE: Readonly<Record<string, readonly string[]>> = {
  bearer: ["token"],
  basic: ["username", "password"],
  header: ["headers"],
  query: ["query"],
  oauth2: ["access_token"],
  oauth2_client: ["client_id", "client_secret"],
  oauth2_private_key: ["client_id", "private_key"],
  aws_sigv4: ["access_key_id", "secret_access_key"],
  token_mint: ["access_token"],
  signed_jwt: ["private_key"],
};

function aadFor(tenant_id: string, id: string): string {
  return `credential:${tenant_id}:${id}`;
}

function templateAadFor(tenant_id: string, template_slug: string): string {
  return `connector-template-credential:${tenant_id}:${template_slug}`;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toView(row: ItemRow): VaultItemView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scope: vaultScopeOf(row),
    environment: row.environment,
    description: row.description,
    version: row.credential_generation,
    connector:
      row.connector_id && row.connector_slug
        ? {
            id: row.connector_id,
            slug: row.connector_slug,
            display_name: row.connector_display_name ?? row.connector_slug,
          }
        : null,
    template_slug: row.template_slug,
    fields: [...(FIELDS_BY_MODE[row.mode] ?? [])],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    rotated_at: iso(row.rotated_at),
    last_used_at: iso(row.last_used_at),
  };
}

export async function vaultViewer(
  db: Executor,
  principal: ResolvedPrincipal,
): Promise<VaultViewer> {
  const granted = new Set<string>();
  for (const permission of Object.values(VAULT_PERMISSION)) {
    const decision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission,
      quiet: true,
    });
    if (decision.allow) granted.add(permission);
  }
  return { user_id: principal.kind === "user" ? principal.id : null, permissions: granted };
}

function visibleTo(viewer: VaultViewer) {
  const own = viewer.user_id ? eq(vaultItems.owner_user_id, viewer.user_id) : sql`false`;
  return viewer.permissions.has(VAULT_PERMISSION.read)
    ? or(isNull(vaultItems.owner_user_id), own)
    : own;
}

function selectItems(db: ScopedTx, tenant_id: string, ...conditions: (SQL | undefined)[]) {
  return db
    .select(COLUMNS)
    .from(vaultItems)
    .leftJoin(connectors, eq(connectors.id, vaultItems.connector_id))
    .where(and(eq(vaultItems.tenant_id, tenant_id), ...conditions));
}

export async function listVaultItems(
  db: Executor,
  tenant_id: string,
  viewer: VaultViewer,
  filter: { scope?: "workspace" | "person" | undefined; kind?: VaultItemKind | undefined } = {},
): Promise<VaultItemView[]> {
  const rows = await withTenantScope(
    db,
    tenant_id,
    async (tx) =>
      (await selectItems(
        tx,
        tenant_id,
        isNull(vaultItems.deleted_at),
        visibleTo(viewer),
        filter.scope === "workspace" ? isNull(vaultItems.owner_user_id) : undefined,
        filter.scope === "person" && viewer.user_id
          ? eq(vaultItems.owner_user_id, viewer.user_id)
          : undefined,
        filter.kind ? eq(vaultItems.kind, filter.kind) : undefined,
      ).orderBy(vaultItems.name, vaultItems.environment)) as ItemRow[],
  );
  return rows.map(toView);
}

async function loadItem(
  db: ScopedTx,
  tenant_id: string,
  id: string,
  viewer: VaultViewer,
  action: VaultAction,
): Promise<ItemRow> {
  const [row] = (await selectItems(
    db,
    tenant_id,
    eq(vaultItems.id, id),
    isNull(vaultItems.deleted_at),
  ).limit(1)) as ItemRow[];
  if (!row) throw new VaultError("not_found", "vault item not found");
  const access = vaultAccess(viewer, row, action);
  if (access === "hidden") throw new VaultError("not_found", "vault item not found");
  if (access === "denied") {
    throw new VaultError(
      "forbidden",
      isEditableKind(row.kind)
        ? `${VAULT_PERMISSION[action]} is required`
        : "this item belongs to a connector; change it on the connector",
    );
  }
  return row;
}

export async function getVaultItem(
  db: Executor,
  tenant_id: string,
  id: string,
  viewer: VaultViewer,
): Promise<VaultItemView> {
  return toView(
    await withTenantScope(db, tenant_id, (tx) => loadItem(tx, tenant_id, id, viewer, "read")),
  );
}

function sealed(tenant_id: string, id: string, value: VaultValue) {
  const plain =
    value.kind === "secret"
      ? serializePlain({ mode: "bearer", token: value.token })
      : serializePlain({ mode: "basic", username: value.username, password: value.password });
  const payload = encryptSecret(plain, aadFor(tenant_id, id));
  return {
    ciphertext: Buffer.from(payload.ciphertext),
    iv: Buffer.from(payload.iv),
    auth_tag: Buffer.from(payload.auth_tag),
  };
}

async function record(
  db: Executor,
  tenant_id: string,
  actor: Actor | null,
  action: AuditActionValue,
  row: { id: string; name: string; kind: string; owner_user_id: string | null },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await auditAwait(
    {
      tenant_id,
      ...auditActor(actor),
      action,
      resource_type: "vault_item",
      resource_id: row.id,
      result: "success",
      metadata: {
        name: row.name,
        kind: row.kind,
        scope: vaultScopeOf(row),
        ...metadata,
      },
    },
    db,
  );
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }).code;
  return code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505";
}

export async function createVaultItem(
  db: Executor,
  input: {
    tenant_id: string;
    actor: Actor | null;
    viewer: VaultViewer;
    kind: VaultEntryKind;
    name: string;
    scope: "workspace" | "person";
    environment: VaultEnvironment;
    description: string | null;
    value: VaultValue;
  },
): Promise<VaultItemView> {
  const owner = input.scope === "person" ? input.viewer.user_id : null;
  if (input.scope === "person" && !owner) {
    throw new VaultError("invalid", "only a person can own a personal vault item");
  }
  if (
    input.scope === "workspace" &&
    vaultAccess(input.viewer, { kind: input.kind, owner_user_id: null }, "write") !== "allow"
  ) {
    throw new VaultError("forbidden", "vault:write is required");
  }
  const id = randomUUID();
  try {
    await withTenantScope(db, input.tenant_id, async (tx) => {
      await tx.insert(vaultItems).values({
        id,
        tenant_id: input.tenant_id,
        kind: input.kind,
        name: input.name,
        description: input.description,
        owner_user_id: owner,
        environment: input.environment,
        mode: input.kind === "secret" ? "bearer" : "basic",
        created_by: input.actor?.id ?? null,
        ...sealed(input.tenant_id, id, input.value),
      });
      await record(tx, input.tenant_id, input.actor, AuditAction.VAULT_ITEM_CREATED, {
        id,
        name: input.name,
        kind: input.kind,
        owner_user_id: owner,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new VaultError("conflict", `a vault item named ${input.name} already exists here`);
    }
    throw error;
  }
  return getVaultItem(db, input.tenant_id, id, input.viewer);
}

export async function updateVaultItem(
  db: Executor,
  input: {
    tenant_id: string;
    id: string;
    actor: Actor | null;
    viewer: VaultViewer;
    description?: string | null;
    value?: VaultValue | VaultLoginPatch;
  },
): Promise<VaultItemView> {
  const action: VaultAction = input.value ? "rotate" : "write";
  const row = await withTenantScope(db, input.tenant_id, (tx) =>
    loadItem(tx, input.tenant_id, input.id, input.viewer, action),
  );
  const valueKind = input.value?.kind === "login_patch" ? "login" : input.value?.kind;
  if (valueKind && valueKind !== row.kind) {
    throw new VaultError("invalid", `this item holds a ${row.kind}`);
  }
  const rotatedVersion = await withTenantScope(db, input.tenant_id, async (tx) => {
    const value =
      input.value?.kind === "login_patch"
        ? await mergedRotationValue(tx, input.tenant_id, row, input.value)
        : input.value;
    const [updated] = await tx
      .update(vaultItems)
      .set({
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(value
          ? {
              ...sealed(input.tenant_id, row.id, value),
              credential_generation: sql`${vaultItems.credential_generation} + 1`,
              rotated_at: new Date(),
            }
          : {}),
        updated_at: new Date(),
      })
      .where(and(eq(vaultItems.tenant_id, input.tenant_id), eq(vaultItems.id, row.id)))
      .returning({ credential_generation: vaultItems.credential_generation });
    const version = input.value ? (updated?.credential_generation ?? null) : null;
    await record(
      tx,
      input.tenant_id,
      input.actor,
      input.value ? AuditAction.VAULT_ITEM_ROTATED : AuditAction.VAULT_ITEM_UPDATED,
      row,
      version === null ? {} : { version },
    );
    return version;
  });
  if (rotatedVersion !== null) {
    logger.info({
      module: "vault",
      action: AuditAction.VAULT_ITEM_ROTATED,
      msg: "vault item rotated",
      tenant_id: input.tenant_id,
      vault_item_id: row.id,
      version: rotatedVersion,
    });
  }
  return getVaultItem(db, input.tenant_id, row.id, input.viewer);
}

export async function deleteVaultItem(
  db: Executor,
  input: { tenant_id: string; id: string; actor: Actor | null; viewer: VaultViewer },
): Promise<void> {
  const row = await withTenantScope(db, input.tenant_id, (tx) =>
    loadItem(tx, input.tenant_id, input.id, input.viewer, "delete"),
  );
  if (row.kind === "connector") {
    await deleteCredential(input.tenant_id, row.id, input.actor, db);
    return;
  }
  await withTenantScope(db, input.tenant_id, async (tx) => {
    await tx
      .delete(vaultItems)
      .where(and(eq(vaultItems.tenant_id, input.tenant_id), eq(vaultItems.id, row.id)));
    await record(tx, input.tenant_id, input.actor, AuditAction.VAULT_ITEM_DELETED, row);
  });
}

async function mergedRotationValue(
  db: ScopedTx,
  tenant_id: string,
  row: ItemRow,
  patch: VaultLoginPatch,
): Promise<VaultValue> {
  const merged = mergedLoginValue(
    revealedFields(row, await openRow(db, tenant_id, row, true)),
    patch,
  );
  if (typeof merged === "string") throw new VaultError("invalid", merged);
  return merged;
}

async function openRow(
  db: ScopedTx,
  tenant_id: string,
  row: ItemRow,
  lock = false,
): Promise<string> {
  const query = db
    .select({ ciphertext: vaultItems.ciphertext, iv: vaultItems.iv, auth_tag: vaultItems.auth_tag })
    .from(vaultItems)
    .where(and(eq(vaultItems.tenant_id, tenant_id), eq(vaultItems.id, row.id)))
    .limit(1);
  const [sealedRow] = await (lock ? query.for("update") : query);
  if (!sealedRow) throw new VaultError("not_found", "vault item not found");
  try {
    return decryptSecret(
      sealedRow,
      row.kind === "template_client" && row.template_slug
        ? templateAadFor(tenant_id, row.template_slug)
        : aadFor(tenant_id, row.id),
    );
  } catch {
    throw new VaultError("unreadable", "this vault item can't be opened with the current key");
  }
}

function revealedFields(row: ItemRow, raw: string): Record<string, string> {
  const decoded: Record<string, unknown> =
    row.kind === "template_client"
      ? (JSON.parse(raw) as Record<string, unknown>)
      : (deserializePlain(row.mode as never, raw) as unknown as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(decoded)) {
    if (key === "mode") continue;
    if (typeof value === "string") out[key] = value;
    else if (value && typeof value === "object") out[key] = JSON.stringify(value);
  }
  return out;
}

export async function revealVaultItem(
  db: Executor,
  input: { tenant_id: string; id: string; actor: Actor | null; viewer: VaultViewer },
): Promise<{ id: string; name: string; values: Record<string, string> }> {
  return withTenantScope(db, input.tenant_id, async (tx) => {
    const row = await loadItem(tx, input.tenant_id, input.id, input.viewer, "reveal");
    const values = revealedFields(row, await openRow(tx, input.tenant_id, row));
    await record(tx, input.tenant_id, input.actor, AuditAction.VAULT_ITEM_REVEALED, row, {
      fields: Object.keys(values),
    });
    return { id: row.id, name: row.name, values };
  });
}

export async function vaultItemActivity(
  db: Executor,
  input: { tenant_id: string; id: string; viewer: VaultViewer; limit?: number },
): Promise<VaultActivityEntry[]> {
  const row = await withTenantScope(db, input.tenant_id, (tx) =>
    loadItem(tx, input.tenant_id, input.id, input.viewer, "read"),
  );
  const rows = await db
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      result: auditLog.result,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, input.tenant_id),
        inArray(auditLog.resource_type, ["vault_item", "credential"]),
        eq(auditLog.resource_id, row.id),
      ),
    )
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(input.limit ?? 50);
  return rows.map((entry) => ({
    id: entry.id,
    at: entry.ts.toISOString(),
    action: entry.action,
    actor_type: entry.actor_type,
    actor_id: entry.actor_id,
    result: entry.result,
    metadata: (entry.metadata ?? {}) as Record<string, unknown>,
  }));
}

export interface ResolvedVaultSecret {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly value: string;
  readonly secrets: readonly string[];
}

export type VaultResolution =
  | { readonly ok: true; readonly secret: ResolvedVaultSecret }
  | {
      readonly ok: false;
      readonly code: "key_not_found" | "decrypt_failed";
      readonly message: string;
    };

function storedValueOf(kind: VaultItemKind, raw: string, mode: string): VaultValue | null {
  if (!isEditableKind(kind)) return null;
  const decoded = deserializePlain(mode as never, raw) as unknown as Record<string, unknown>;
  if (kind === "secret" && typeof decoded.token === "string") {
    return { kind, token: decoded.token };
  }
  if (
    kind === "login" &&
    typeof decoded.username === "string" &&
    typeof decoded.password === "string"
  ) {
    return { kind, username: decoded.username, password: decoded.password };
  }
  return null;
}

interface ResolveVaultHandleInput {
  tenant_id: string;
  environment: VaultEnvironment;
  user_id: string | null;
  handle: VaultHandle;
  execution_id?: string | null;
  step_id?: string | null;
}

export async function resolveVaultHandle(
  db: Executor,
  input: ResolveVaultHandleInput,
): Promise<VaultResolution> {
  return withTenantScope(db, input.tenant_id, (tx) => resolveScopedHandle(tx, input));
}

async function resolveScopedHandle(
  db: ScopedTx,
  input: ResolveVaultHandleInput,
): Promise<VaultResolution> {
  const candidates = (await selectItems(
    db,
    input.tenant_id,
    eq(vaultItems.name, input.handle.name),
    eq(vaultItems.environment, input.environment),
    inArray(vaultItems.kind, ["secret", "login"]),
    isNull(vaultItems.deleted_at),
  ).limit(5)) as ItemRow[];
  const row = candidates.find((candidate) => handleMatches(input.handle, candidate, input.user_id));
  const label = `secret.${input.handle.scope === "person" ? "me." : ""}${input.handle.name}`;
  if (!row) {
    return {
      ok: false,
      code: "key_not_found",
      message: `no vault item ${label} in ${input.environment}`,
    };
  }
  let value: VaultValue | null;
  try {
    value = storedValueOf(row.kind, await openRow(db, input.tenant_id, row), row.mode);
  } catch {
    return { ok: false, code: "decrypt_failed", message: `vault item ${label} can't be opened` };
  }
  if (!value) {
    return { ok: false, code: "decrypt_failed", message: `vault item ${label} has no value` };
  }
  const field: VaultField | null = input.handle.field;
  const resolved = vaultFieldValue(value, field);
  if (resolved === null) {
    return {
      ok: false,
      code: "key_not_found",
      message: `vault item ${label} is a ${row.kind} and has no ${field ?? "default"} field`,
    };
  }
  await db
    .update(vaultItems)
    .set({ last_used_at: new Date() })
    .where(and(eq(vaultItems.tenant_id, input.tenant_id), eq(vaultItems.id, row.id)));
  await record(db, input.tenant_id, null, AuditAction.VAULT_ITEM_USED, row, {
    version: row.credential_generation,
    field: field ?? null,
    environment: input.environment,
    ...(input.execution_id ? { execution_id: input.execution_id } : {}),
    ...(input.step_id ? { step_id: input.step_id } : {}),
  });
  return {
    ok: true,
    secret: {
      id: row.id,
      name: row.name,
      version: row.credential_generation,
      value: resolved,
      secrets: [resolved, ...vaultSecretsOf(value)],
    },
  };
}

export async function prepareVaultValues(
  db: Executor,
  input: {
    tenant_id: string;
    environment: VaultEnvironment;
    user_id: string | null;
    handles: readonly VaultHandle[];
    execution_id?: string | null;
    step_id?: string | null;
  },
): Promise<PreparedVaultValues> {
  const values = new Map<string, PreparedVaultValue>();
  for (const handle of input.handles) {
    const key = vaultValueKey(handle);
    if (values.has(key)) continue;
    const resolved = await resolveVaultHandle(db, { ...input, handle });
    values.set(
      key,
      resolved.ok
        ? { ok: true, value: resolved.secret.value, secrets: resolved.secret.secrets }
        : resolved,
    );
  }
  return values;
}
