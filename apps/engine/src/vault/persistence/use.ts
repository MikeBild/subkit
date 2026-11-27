import type { VaultEntryKind, VaultEntryValue } from "@shared/vault-kinds.ts";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Executor } from "../../db/index.ts";
import { sessions, vaultItems, withTenantScope } from "../../db/index.ts";
import {
  type VaultEnvironment,
  type VaultItemKind,
  vaultAccess,
  vaultScopeOf,
} from "../core/vault-item.ts";
import { vaultViewer } from "../service.ts";
import { type ItemRow, openSealedRow, selectItems, storedValueOf, VaultError } from "./store.ts";

export interface VaultItemForUse {
  readonly item_id: string;
  readonly name: string;
  readonly kind: VaultItemKind;
  readonly scope: "workspace" | "person";
  readonly owner_user_id: string | null;
  readonly version: number;
  readonly fields: Record<string, unknown>;
  readonly origins: readonly string[];
  readonly value_digest: string;
}

export interface ResolveForUseInput {
  readonly tenant_id: string;
  readonly principal: ResolvedPrincipal;
  readonly name: string;
  readonly kind: VaultEntryKind;
  readonly environment: VaultEnvironment;
}

function preferPersonal(rows: readonly ItemRow[], user_id: string | null): ItemRow | undefined {
  return (
    rows.find((row) => user_id !== null && row.owner_user_id === user_id) ??
    rows.find((row) => row.owner_user_id === null)
  );
}

export async function resolveVaultItemForUse(
  db: Executor,
  input: ResolveForUseInput,
): Promise<VaultItemForUse> {
  const viewer = await vaultViewer(db, input.principal);
  const personal = input.name.startsWith("me.");
  const name = personal ? input.name.slice(3) : input.name;
  return withTenantScope(db, input.tenant_id, async (tx) => {
    const rows = (await selectItems(
      tx,
      input.tenant_id,
      eq(vaultItems.name, name),
      eq(vaultItems.environment, input.environment),
      isNull(vaultItems.deleted_at),
    ).limit(5)) as ItemRow[];
    const row = preferPersonal(
      personal ? rows.filter((candidate) => candidate.owner_user_id !== null) : rows,
      viewer.user_id,
    );
    if (!row || vaultAccess(viewer, row, "use") === "hidden") {
      throw new VaultError("not_found", `no vault item ${input.name} in ${input.environment}`);
    }
    if (row.kind !== input.kind) {
      throw new VaultError(
        "invalid",
        `vault item ${input.name} is a ${row.kind}, not a ${input.kind}`,
      );
    }
    if (vaultAccess(viewer, row, "use") !== "allow") {
      throw new VaultError("forbidden", "vault:use is required for workspace items");
    }
    const opened = row.value_digest === null ? await openSealedRow(tx, row) : null;
    return {
      item_id: row.id,
      name: row.name,
      kind: row.kind,
      scope: vaultScopeOf(row),
      owner_user_id: row.owner_user_id,
      version: row.credential_generation,
      fields: row.fields ?? {},
      origins: [...(row.origins ?? [])],
      value_digest: row.value_digest ?? (opened?.value_digest as string),
    };
  });
}

export async function decryptVaultItemValue(
  db: Executor,
  input: { tenant_id: string; item_id: string; value_digest?: string },
): Promise<VaultEntryValue> {
  return withTenantScope(db, input.tenant_id, async (tx) => {
    const [row] = (await selectItems(
      tx,
      input.tenant_id,
      eq(vaultItems.id, input.item_id),
      isNull(vaultItems.deleted_at),
    ).limit(1)) as ItemRow[];
    if (!row) throw new VaultError("not_found", "vault item not found");
    const opened = await openSealedRow(tx, row);
    if (input.value_digest !== undefined && input.value_digest !== opened.value_digest) {
      throw new VaultError("conflict", "the vault item changed since it was approved");
    }
    const value = storedValueOf(row.kind, opened.plain, row.mode);
    if (!value) throw new VaultError("unreadable", "this vault item has no usable value");
    await tx
      .update(vaultItems)
      .set({ last_used_at: new Date() })
      .where(and(eq(vaultItems.tenant_id, input.tenant_id), eq(vaultItems.id, row.id)));
    return value;
  });
}

export async function sessionAuthTime(
  db: Executor,
  principal: ResolvedPrincipal,
): Promise<Date | null> {
  const session_id =
    principal.auth_source?.kind === "browser_session"
      ? principal.auth_source.session_id
      : principal.session_id;
  if (principal.kind !== "user" || !session_id) return null;
  const [session] = await withTenantScope(db, principal.tenant_id, (tx) =>
    tx
      .select({ created_at: sessions.created_at })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, session_id),
          eq(sessions.tenant_id, principal.tenant_id),
          eq(sessions.user_id, principal.id),
          isNull(sessions.revoked_at),
        ),
      )
      .limit(1),
  );
  return session?.created_at ?? null;
}
