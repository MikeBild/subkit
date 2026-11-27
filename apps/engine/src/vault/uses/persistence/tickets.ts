import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import { decryptSecret, encryptSecret } from "../../../crypto/index.ts";
import type { Executor, ScopedTx } from "../../../db/index.ts";
import {
  deviceCommands,
  type VaultUsePurpose,
  type VaultUseStatus,
  vaultSecretTickets,
  vaultUses,
  withTenantScope,
} from "../../../db/index.ts";
import { SECRET_TICKET_TTL_MS, ticketAad, useStatusesBefore } from "../core/rules.ts";

export interface VaultUseStart {
  readonly tenant_id: string;
  readonly item_id: string;
  readonly actor_id: string | null;
  readonly purpose: VaultUsePurpose;
  readonly origin: string;
  readonly conversation_id: string | null;
  readonly run_id: string | null;
  readonly task_id: string | null;
  readonly device_id: string;
  readonly command_id: string;
}

export type StartedUse =
  | { readonly ok: true; readonly use_id: string; readonly ticket_id: string }
  | { readonly ok: false; readonly code: "already_used" };

export async function startVaultUse(
  db: Executor,
  start: VaultUseStart,
  values: Readonly<Record<string, string>>,
  now: Date,
): Promise<StartedUse> {
  return await withTenantScope(db, start.tenant_id, async (tx) => {
    const [use] = await tx
      .insert(vaultUses)
      .values({ ...start, status: "pending" })
      .onConflictDoNothing({ target: [vaultUses.tenant_id, vaultUses.command_id] })
      .returning({ id: vaultUses.id });
    if (!use) return { ok: false, code: "already_used" } as const;
    const ticket_id = randomUUID();
    const sealed = encryptSecret(JSON.stringify(values), ticketAad(start.tenant_id, ticket_id));
    await tx.insert(vaultSecretTickets).values({
      id: ticket_id,
      tenant_id: start.tenant_id,
      device_id: start.device_id,
      use_id: use.id,
      command_id: start.command_id,
      payload_ciphertext: sealed.ciphertext,
      payload_iv: sealed.iv,
      payload_auth_tag: sealed.auth_tag,
      expires_at: new Date(now.getTime() + SECRET_TICKET_TTL_MS),
    });
    return { ok: true, use_id: use.id, ticket_id } as const;
  });
}

export type TicketClaim =
  | { readonly ok: true; readonly values: Record<string, string>; readonly expires_at: Date }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 410;
      readonly code: "ticket_not_found" | "command_not_running" | "ticket_gone";
    };

function parsedValues(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function claimSecretTicket(
  db: Executor,
  p: { readonly tenant_id: string; readonly device_id: string; readonly ticket_id: string },
  now: Date,
): Promise<TicketClaim> {
  return await withTenantScope(db, p.tenant_id, async (tx) => {
    const [ticket] = await tx
      .select()
      .from(vaultSecretTickets)
      .where(
        and(eq(vaultSecretTickets.tenant_id, p.tenant_id), eq(vaultSecretTickets.id, p.ticket_id)),
      )
      .for("update")
      .limit(1);
    if (!ticket) return { ok: false, status: 410, code: "ticket_gone" } as const;
    if (ticket.device_id !== p.device_id)
      return { ok: false, status: 404, code: "ticket_not_found" } as const;
    if (ticket.expires_at.getTime() <= now.getTime()) {
      await tx.delete(vaultSecretTickets).where(eq(vaultSecretTickets.id, ticket.id));
      await moveUse(tx, p.tenant_id, ticket.use_id, "failed");
      return { ok: false, status: 410, code: "ticket_gone" } as const;
    }
    const [command] = await tx
      .select({ state: deviceCommands.state, device_id: deviceCommands.device_id })
      .from(deviceCommands)
      .where(
        and(eq(deviceCommands.tenant_id, p.tenant_id), eq(deviceCommands.id, ticket.command_id)),
      )
      .limit(1);
    if (!command || command.device_id !== p.device_id || command.state !== "claimed")
      return { ok: false, status: 409, code: "command_not_running" } as const;
    await tx.delete(vaultSecretTickets).where(eq(vaultSecretTickets.id, ticket.id));
    await moveUse(tx, p.tenant_id, ticket.use_id, "running");
    const values = parsedValues(
      decryptSecret(
        {
          ciphertext: ticket.payload_ciphertext,
          iv: ticket.payload_iv,
          auth_tag: ticket.payload_auth_tag,
        },
        ticketAad(p.tenant_id, ticket.id),
      ),
    );
    return { ok: true, values, expires_at: ticket.expires_at } as const;
  });
}

async function moveUse(
  tx: ScopedTx,
  tenant_id: string,
  use_id: string,
  to: VaultUseStatus,
): Promise<{ readonly moved: boolean }> {
  const rows = await tx
    .update(vaultUses)
    .set({ status: to, updated_at: new Date() })
    .where(
      and(
        eq(vaultUses.tenant_id, tenant_id),
        eq(vaultUses.id, use_id),
        inArray(vaultUses.status, useStatusesBefore(to)),
      ),
    )
    .returning({ id: vaultUses.id });
  return { moved: rows.length > 0 };
}

export async function settleVaultUse(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly use_id: string;
    readonly status: VaultUseStatus;
    readonly actor_id: string | null;
  },
): Promise<void> {
  await withTenantScope(db, p.tenant_id, async (tx) => {
    await tx
      .delete(vaultSecretTickets)
      .where(
        and(eq(vaultSecretTickets.tenant_id, p.tenant_id), eq(vaultSecretTickets.use_id, p.use_id)),
      );
    const [use] = await tx
      .select()
      .from(vaultUses)
      .where(and(eq(vaultUses.tenant_id, p.tenant_id), eq(vaultUses.id, p.use_id)))
      .limit(1);
    if (!use) return;
    const target: VaultUseStatus =
      use.status === "pending" && p.status !== "failed" ? "failed" : p.status;
    const { moved } = await moveUse(tx, p.tenant_id, p.use_id, target);
    if (!moved) return;
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.VAULT_ITEM_USED,
        resource_type: "vault_item",
        resource_id: use.item_id,
        result: target === "failed" ? "error" : "success",
        metadata: {
          purpose: use.purpose,
          origin: use.origin,
          use_id: use.id,
          outcome: target,
          ...(use.conversation_id ? { conversation_id: use.conversation_id } : {}),
          ...(use.run_id ? { run_id: use.run_id } : {}),
          ...(use.task_id ? { task_id: use.task_id } : {}),
        },
      },
      tx,
    );
  });
}

export async function priorUseBlocks(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly item_id: string;
    readonly purpose: VaultUsePurpose;
    readonly origin: string;
    readonly conversation_id: string | null;
    readonly run_id: string | null;
  },
): Promise<boolean> {
  const owner =
    p.run_id !== null
      ? eq(vaultUses.run_id, p.run_id)
      : p.conversation_id !== null
        ? eq(vaultUses.conversation_id, p.conversation_id)
        : null;
  if (owner === null) return false;
  const rows = await withTenantScope(db, p.tenant_id, (tx) =>
    tx
      .select({ id: vaultUses.id })
      .from(vaultUses)
      .where(
        and(
          eq(vaultUses.tenant_id, p.tenant_id),
          eq(vaultUses.item_id, p.item_id),
          eq(vaultUses.purpose, p.purpose),
          eq(vaultUses.origin, p.origin),
          owner,
          inArray(vaultUses.status, ["running", "submitted", "uncertain"]),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}
