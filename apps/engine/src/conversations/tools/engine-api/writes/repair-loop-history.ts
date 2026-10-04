import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../../db/client.ts";
import { conversationToolCalls } from "../../../../db/schema/index.ts";
import { type RepairLoopVerdict, tallyRepairSignals } from "./repair-loop-tally.ts";

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
