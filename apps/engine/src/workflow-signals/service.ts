import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflowSignals } from "../db/schema/workflow_signals.ts";

export interface SignalRow {
  id: string;
  payload: Record<string, unknown>;
  received_at: Date;
}

export async function appendSignal(
  db: Db,
  p: {
    tenant_id: string;
    execution_id: string;
    event_name: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(workflowSignals)
    .values({
      tenant_id: p.tenant_id,
      execution_id: p.execution_id,
      event_name: p.event_name,
      payload: p.payload ?? {},
    })
    .returning({ id: workflowSignals.id });
  return { id: row!.id };
}

function pathMatches(
  payload: Record<string, unknown>,
  path: string,
  equals: string | number | boolean | null,
): boolean {
  let cur: unknown = payload;
  for (const segment of path.split(".")) {
    if (cur === null || cur === undefined) return false;
    if (typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur === equals;
}

export async function consumeMatchingSignal(
  db: Db,
  p: {
    tenant_id: string;
    execution_id: string;
    event_name: string;
    match?: { path: string; equals: string | number | boolean | null };
  },
): Promise<SignalRow | undefined> {
  const rows = await db
    .select()
    .from(workflowSignals)
    .where(
      and(
        eq(workflowSignals.tenant_id, p.tenant_id),
        eq(workflowSignals.execution_id, p.execution_id),
        eq(workflowSignals.event_name, p.event_name),
        isNull(workflowSignals.consumed_at),
      ),
    )
    .orderBy(workflowSignals.received_at);
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (p.match && !pathMatches(payload, p.match.path, p.match.equals)) {
      continue;
    }
    const claimed = await db
      .update(workflowSignals)
      .set({ consumed_at: sql`now()` })
      .where(and(eq(workflowSignals.id, row.id), isNull(workflowSignals.consumed_at)))
      .returning({ id: workflowSignals.id });
    if (claimed[0]) {
      return { id: row.id, payload, received_at: row.received_at };
    }
  }
  return undefined;
}
