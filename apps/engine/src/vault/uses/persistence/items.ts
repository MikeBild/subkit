import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import type { Executor } from "../../../db/index.ts";
import { vaultItems, withTenantScope } from "../../../db/index.ts";
import type { VaultEnvironment } from "../../core/vault-item.ts";
import { VaultError } from "../../persistence/store.ts";
import { resolveVaultItemForUse, type VaultItemForUse } from "../../persistence/use.ts";

export type ItemLookup =
  | { readonly ok: true; readonly item: VaultItemForUse }
  | { readonly ok: false; readonly code: "vault_item_not_found" | "vault_item_forbidden" };

async function lookup(
  db: Executor,
  input: Parameters<typeof resolveVaultItemForUse>[1],
): Promise<ItemLookup> {
  try {
    return { ok: true, item: await resolveVaultItemForUse(db, input) };
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    return {
      ok: false,
      code: error.code === "forbidden" ? "vault_item_forbidden" : "vault_item_not_found",
    };
  }
}

export async function findLoginForUse(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly principal: ResolvedPrincipal;
    readonly name: string;
    readonly environment: VaultEnvironment;
  },
): Promise<ItemLookup> {
  return await lookup(db, { ...p, kind: "login" });
}

async function cardNameByLast4(
  db: Executor,
  tenant_id: string,
  owner_user_id: string,
  last4: string,
): Promise<string | null> {
  const rows = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select({ name: vaultItems.name })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, tenant_id),
          eq(vaultItems.owner_user_id, owner_user_id),
          eq(vaultItems.kind, "card"),
          isNull(vaultItems.deleted_at),
          sql`${vaultItems.fields} ->> 'last4' = ${last4}`,
        ),
      )
      .limit(2),
  );
  return rows.length === 1 ? (rows[0]?.name ?? null) : null;
}

export async function findCardForUse(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly principal: ResolvedPrincipal;
    readonly card: string;
    readonly environment: VaultEnvironment;
  },
): Promise<ItemLookup> {
  const byLast4 = /^[0-9]{4}$/u.test(p.card)
    ? await cardNameByLast4(db, p.tenant_id, p.principal.id, p.card)
    : null;
  const name = byLast4 ?? p.card.replace(/^me\./u, "");
  const found = await lookup(db, {
    tenant_id: p.tenant_id,
    principal: p.principal,
    name: `me.${name}`,
    kind: "card",
    environment: p.environment,
  });
  if (!found.ok) return found;
  return found.item.owner_user_id === p.principal.id
    ? found
    : { ok: false, code: "vault_item_forbidden" };
}

export interface OwnedItem {
  readonly item_id: string;
  readonly name: string;
  readonly origins: readonly string[];
  readonly fields: Record<string, unknown>;
  readonly value_digest: string | undefined;
}

export async function findItemForDeviceOwner(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly owner_user_id: string;
    readonly reference: string;
    readonly kind: "login" | "card";
    readonly environment: VaultEnvironment;
  },
): Promise<OwnedItem | null> {
  const personal = p.reference.startsWith("me.");
  const reference = personal ? p.reference.slice(3) : p.reference;
  const byLast4 = p.kind === "card" && /^[0-9]{4}$/u.test(reference);
  const rows = await withTenantScope(db, p.tenant_id, (tx) =>
    tx
      .select({
        id: vaultItems.id,
        name: vaultItems.name,
        owner_user_id: vaultItems.owner_user_id,
        origins: vaultItems.origins,
        fields: vaultItems.fields,
        value_digest: vaultItems.value_digest,
      })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, p.tenant_id),
          eq(vaultItems.kind, p.kind),
          eq(vaultItems.environment, p.environment),
          isNull(vaultItems.deleted_at),
          byLast4
            ? sql`${vaultItems.fields} ->> 'last4' = ${reference}`
            : eq(vaultItems.name, reference),
          personal || p.kind === "card"
            ? eq(vaultItems.owner_user_id, p.owner_user_id)
            : or(eq(vaultItems.owner_user_id, p.owner_user_id), isNull(vaultItems.owner_user_id)),
        ),
      )
      .limit(3),
  );
  const row =
    rows.find((candidate) => candidate.owner_user_id === p.owner_user_id) ??
    (rows.length === 1 ? rows[0] : undefined);
  if (!row || (byLast4 && rows.length > 1)) return null;
  return {
    item_id: row.id,
    name: row.name,
    origins: row.origins,
    fields: row.fields,
    value_digest: row.value_digest ?? undefined,
  };
}
