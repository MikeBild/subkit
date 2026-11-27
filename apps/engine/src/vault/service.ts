import { randomUUID } from "node:crypto";
import type { VaultField, VaultHandle } from "@shared/vault-handle.ts";
import {
  fieldsOfKind,
  isPersonalOnlyKind,
  needsFreshAuthToReveal,
  usableInConnectorSteps,
} from "@shared/vault-kinds.ts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Actor } from "../audit/actor.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { deleteCredential } from "../credentials/service.ts";
import type { Executor } from "../db/client.ts";
import { type ScopedTx, withTenantScope } from "../db/index.ts";
import { auditLog, vaultItems } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import { can } from "../rbac/evaluator.ts";
import {
  type PreparedVaultValue,
  type PreparedVaultValues,
  vaultValueKey,
} from "./core/injection.ts";
import { normalizeOrigins } from "./core/kinds.ts";
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
import {
  type ItemRow,
  modeOf,
  openRow,
  record,
  revealedFields,
  sealed,
  selectItems,
  storedValueOf,
  VaultError,
  visibleTo,
} from "./persistence/store.ts";

export { VaultError };

export const FRESH_AUTH_MAX_AGE_MS = 5 * 60 * 1000;

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
  metadata: Record<string, unknown>;
  origins: string[];
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

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function fieldNamesOf(row: ItemRow): string[] {
  if (!isEditableKind(row.kind)) return [...(FIELDS_BY_MODE[row.mode] ?? [])];
  if (row.kind === "login") {
    return row.fields.has_totp === true
      ? ["username", "password", "totp_seed"]
      : ["username", "password"];
  }
  return [...fieldsOfKind(row.kind)];
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
    fields: fieldNamesOf(row),
    metadata: row.fields ?? {},
    origins: row.kind === "login" ? [...(row.origins ?? [])] : [],
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

export function freshAuth(auth_time: Date | null, now: Date = new Date()): boolean {
  if (auth_time === null) return false;
  const age = now.getTime() - auth_time.getTime();
  return age >= -60_000 && age <= FRESH_AUTH_MAX_AGE_MS;
}

function originsFor(kind: VaultItemKind, raw: readonly string[] | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  if (kind !== "login") throw new VaultError("invalid", "only a login is bound to websites");
  const origins = normalizeOrigins(raw);
  if (typeof origins === "string") throw new VaultError("invalid", origins);
  return origins;
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
    origins?: readonly string[];
  },
): Promise<VaultItemView> {
  const owner = input.scope === "person" ? input.viewer.user_id : null;
  if (input.scope === "person" && !owner) {
    throw new VaultError("invalid", "only a person can own a personal vault item");
  }
  if (input.value.kind !== input.kind) {
    throw new VaultError("invalid", `the value is a ${input.value.kind}, not a ${input.kind}`);
  }
  if (isPersonalOnlyKind(input.kind) && input.scope !== "person") {
    throw new VaultError(
      "invalid",
      "cards, bank accounts and identities are personal; save them for yourself only",
    );
  }
  const origins = originsFor(input.kind, input.origins);
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
        mode: modeOf(input.kind),
        origins,
        created_by: input.actor?.id ?? null,
        ...sealed({ tenant_id: input.tenant_id, id, owner_user_id: owner }, input.value),
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
    origins?: readonly string[];
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
  const origins = input.origins === undefined ? undefined : originsFor(row.kind, input.origins);
  const rotatedVersion = await withTenantScope(db, input.tenant_id, async (tx) => {
    const value =
      input.value?.kind === "login_patch"
        ? await mergedRotationValue(tx, row, input.value)
        : input.value;
    const [updated] = await tx
      .update(vaultItems)
      .set({
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(origins !== undefined ? { origins } : {}),
        ...(value
          ? {
              ...sealed(row, value),
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
  row: ItemRow,
  patch: VaultLoginPatch,
): Promise<VaultValue> {
  const merged = mergedLoginValue(revealedFields(row, await openRow(db, row, true)), patch);
  if (typeof merged === "string") throw new VaultError("invalid", merged);
  return merged;
}

export async function revealVaultItem(
  db: Executor,
  input: {
    tenant_id: string;
    id: string;
    actor: Actor | null;
    viewer: VaultViewer;
    auth_time?: Date | null;
    now?: Date;
  },
): Promise<{ id: string; name: string; values: Record<string, string> }> {
  return withTenantScope(db, input.tenant_id, async (tx) => {
    const row = await loadItem(tx, input.tenant_id, input.id, input.viewer, "reveal");
    if (needsFreshAuthToReveal(row.kind) && !freshAuth(input.auth_time ?? null, input.now)) {
      throw new VaultError(
        "reauth_required",
        "sign in again to show a card or bank account; the sign-in must be less than 5 minutes old",
      );
    }
    const values = revealedFields(row, await openRow(tx, row));
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
    const other = await connectorStepRefusal(db, input, label);
    if (other) return other;
    return {
      ok: false,
      code: "key_not_found",
      message: `no vault item ${label} in ${input.environment}`,
    };
  }
  let value: VaultValue | null;
  try {
    value = storedValueOf(row.kind, await openRow(db, row), row.mode);
  } catch (error) {
    logger.warn({
      module: "vault",
      msg: "vault item could not be opened",
      tenant_id: input.tenant_id,
      vault_item_id: row.id,
      error: error instanceof Error ? error.name : "unknown",
    });
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

async function connectorStepRefusal(
  db: ScopedTx,
  input: ResolveVaultHandleInput,
  label: string,
): Promise<VaultResolution | null> {
  const others = (await selectItems(
    db,
    input.tenant_id,
    eq(vaultItems.name, input.handle.name),
    eq(vaultItems.environment, input.environment),
    isNull(vaultItems.deleted_at),
  ).limit(5)) as ItemRow[];
  const other = others.find(
    (candidate) =>
      !usableInConnectorSteps(candidate.kind) &&
      handleMatches(input.handle, candidate, input.user_id),
  );
  if (!other) return null;
  return {
    ok: false,
    code: "key_not_found",
    message: `vault item ${label} is a ${other.kind}; only secrets and logins go into connector steps`,
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
