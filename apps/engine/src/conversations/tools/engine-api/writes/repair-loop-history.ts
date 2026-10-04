import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../../db/client.ts";
import { conversationToolCalls } from "../../../../db/schema/index.ts";
import { type RepairLoopVerdict, tallyRepairSignals } from "./repair-loop-tally.ts";

/**
 * Circuit-breaker for repair loops. Fetches the recent tool-call history
 * for this conversation and delegates to `tallyRepairSignals`, which
 * counts two trip signals (a repeating authoring-bug warning code, and a
 * repeating runtime execution failure keyed on `exec_failed:<step>:<code>`)
 * and refuses the run when either reaches the threshold — instead of
 * burning the rest of the step budget on a draft that won't work.
 */
export async function detectRepairLoop(
  db: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<RepairLoopVerdict> {
  try {
    const rows = await db
      .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, tenant_id),
          eq(conversationToolCalls.conversation_id, conversation_id),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(8);
    return tallyRepairSignals(rows);
  } catch {
    return { tripped: false, recent_codes: [], tripped_codes: [] };
  }
}
