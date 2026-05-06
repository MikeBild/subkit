// Tunnel DB service — CRUD on the `tunnels` + `tunnel_targets` rows.
//
// Upsert semantics: the WebSocket endpoint calls `upsertTunnel` inside a
// transaction to materialise one row per (tenant_id, name) and replace
// the set of `tunnel_targets`. Pre-registration via the HTTP API uses
// the same function with `state = "registered"`.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { tunnels, tunnelTargets } from "../db/schema/index.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TunnelTargetInput {
  name: string;
  local_base_url: string;
  concurrency_cap?: number;
}

export interface TunnelRow {
  id: string;
  tenant_id: string;
  name: string;
  state: "registered" | "connected" | "disconnected";
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TunnelTargetRow {
  id: string;
  tenant_id: string;
  tunnel_id: string;
  target_name: string;
  concurrency_cap: number;
}

/**
 * Cheap SHA-256 fingerprint of the API key used to open the tunnel.
 * Stored alongside the row so we can re-identify an agent across reconnects.
 */
export function fingerprintAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function upsertTunnel(
  params: {
    tenant_id: string;
    name: string;
    agent_token_sha256: string;
    state: "registered" | "connected" | "disconnected";
    targets: TunnelTargetInput[];
  },
  executor: Executor,
): Promise<{ tunnel: TunnelRow; targets: TunnelTargetRow[] }> {
  return await (executor as Db).transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(tunnels)
      .where(and(eq(tunnels.tenant_id, params.tenant_id), eq(tunnels.name, params.name)))
      .limit(1);
    const existingRow = existing[0];
    const now = new Date();
    let row: TunnelRow;
    if (existingRow) {
      const [updated] = await tx
        .update(tunnels)
        .set({
          agent_token_sha256: params.agent_token_sha256,
          state: params.state,
          last_seen_at: params.state === "connected" ? now : existingRow.last_seen_at,
          updated_at: now,
        })
        .where(eq(tunnels.id, existingRow.id))
        .returning();
      row = updated as TunnelRow;
    } else {
      const [inserted] = await tx
        .insert(tunnels)
        .values({
          tenant_id: params.tenant_id,
          name: params.name,
          agent_token_sha256: params.agent_token_sha256,
          state: params.state,
          last_seen_at: params.state === "connected" ? now : null,
        })
        .returning();
      row = inserted as TunnelRow;
    }

    // Replace the set of targets in full — the agent is source of truth.
    await tx.delete(tunnelTargets).where(eq(tunnelTargets.tunnel_id, row.id));
    if (params.targets.length > 0) {
      await tx.insert(tunnelTargets).values(
        params.targets.map((t) => ({
          tenant_id: params.tenant_id,
          tunnel_id: row.id,
          target_name: t.name,
          concurrency_cap: t.concurrency_cap ?? 32,
        })),
      );
    }
    const targetRows = (await tx
      .select()
      .from(tunnelTargets)
      .where(
        and(eq(tunnelTargets.tenant_id, params.tenant_id), eq(tunnelTargets.tunnel_id, row.id)),
      )) as TunnelTargetRow[];
    return { tunnel: row, targets: targetRows };
  });
}

export async function markTunnelDisconnected(
  tenant_id: string,
  tunnel_id: string,
  executor: Executor,
): Promise<void> {
  await (executor as Db)
    .update(tunnels)
    .set({ state: "disconnected", updated_at: new Date() })
    .where(and(eq(tunnels.tenant_id, tenant_id), eq(tunnels.id, tunnel_id)));
}

export async function touchTunnelLastSeen(
  tenant_id: string,
  tunnel_id: string,
  executor: Executor,
): Promise<void> {
  await (executor as Db)
    .update(tunnels)
    .set({ last_seen_at: new Date() })
    .where(and(eq(tunnels.tenant_id, tenant_id), eq(tunnels.id, tunnel_id)));
}

export async function listTunnels(
  tenant_id: string,
  executor: Executor,
): Promise<Array<TunnelRow & { targets: TunnelTargetRow[] }>> {
  const rows = (await (executor as Db)
    .select()
    .from(tunnels)
    .where(eq(tunnels.tenant_id, tenant_id))) as TunnelRow[];
  const result: Array<TunnelRow & { targets: TunnelTargetRow[] }> = [];
  for (const row of rows) {
    const t = (await (executor as Db)
      .select()
      .from(tunnelTargets)
      .where(
        and(eq(tunnelTargets.tenant_id, tenant_id), eq(tunnelTargets.tunnel_id, row.id)),
      )) as TunnelTargetRow[];
    result.push({ ...row, targets: t });
  }
  return result;
}

export async function getTunnel(
  tenant_id: string,
  id: string,
  executor: Executor,
): Promise<(TunnelRow & { targets: TunnelTargetRow[] }) | null> {
  const rows = (await (executor as Db)
    .select()
    .from(tunnels)
    .where(and(eq(tunnels.tenant_id, tenant_id), eq(tunnels.id, id)))
    .limit(1)) as TunnelRow[];
  const row = rows[0];
  if (!row) return null;
  const t = (await (executor as Db)
    .select()
    .from(tunnelTargets)
    .where(
      and(eq(tunnelTargets.tenant_id, tenant_id), eq(tunnelTargets.tunnel_id, row.id)),
    )) as TunnelTargetRow[];
  return { ...row, targets: t };
}

export async function deleteTunnel(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  executor: Executor,
): Promise<boolean> {
  return await (executor as Db).transaction(async (tx) => {
    const existing = (await tx
      .select()
      .from(tunnels)
      .where(and(eq(tunnels.tenant_id, tenant_id), eq(tunnels.id, id)))
      .limit(1)) as TunnelRow[];
    const row = existing[0];
    if (!row) return false;

    const res = await tx
      .delete(tunnels)
      .where(and(eq(tunnels.tenant_id, tenant_id), eq(tunnels.id, id)))
      .returning({ id: tunnels.id });
    if (res.length === 0) return false;

    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.TUNNEL_UNREGISTERED,
        resource_type: "tunnel",
        resource_id: id,
        result: "success",
        metadata: { name: row.name },
      },
      tx,
    );
    return true;
  });
}
