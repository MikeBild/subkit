import type { Executor } from "../../db/index.ts";
import { VaultError } from "../persistence/store.ts";
import { decryptVaultItemValue } from "../persistence/use.ts";
import { signInTicketValues } from "./core/rules.ts";
import { startVaultUse, type VaultUseStart } from "./persistence/tickets.ts";

export interface SignInIntent {
  readonly item_id: string;
  readonly value_digest: string | undefined;
  readonly kind: "password" | "totp";
  readonly fields: {
    readonly username?: string;
    readonly password?: string;
    readonly code?: string;
  };
}

export type SignInTicket =
  | {
      readonly ok: true;
      readonly use_id: string;
      readonly ticket_id: string;
      readonly secrets: readonly string[];
    }
  | { readonly ok: false; readonly code: "already_used" | "vault_item_changed" | "totp_missing" };

export async function mintSignInTicket(
  db: Executor,
  start: Omit<VaultUseStart, "purpose" | "item_id">,
  intent: SignInIntent,
  now: Date,
): Promise<SignInTicket> {
  let value: Awaited<ReturnType<typeof decryptVaultItemValue>>;
  try {
    value = await decryptVaultItemValue(db, {
      tenant_id: start.tenant_id,
      item_id: intent.item_id,
      ...(intent.value_digest === undefined ? {} : { value_digest: intent.value_digest }),
    });
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, code: "vault_item_changed" };
    throw error;
  }
  if (value.kind !== "login") return { ok: false, code: "vault_item_changed" };
  if ((intent.kind === "totp" || intent.fields.code) && !value.totp_seed)
    return { ok: false, code: "totp_missing" };
  const values = signInTicketValues(value, intent.kind, intent.fields);
  const started = await startVaultUse(
    db,
    { ...start, purpose: "sign_in", item_id: intent.item_id },
    values,
    now,
  );
  return started.ok ? { ...started, secrets: Object.values(values) } : started;
}
