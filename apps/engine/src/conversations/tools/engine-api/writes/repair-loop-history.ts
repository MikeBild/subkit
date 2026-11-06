import type { Db } from "../../../../db/client.ts";
import { listRecentToolCallOutputs } from "../../../service/tool-state.ts";
import { type RepairLoopVerdict, tallyRepairSignals } from "./repair-loop-tally.ts";

export async function detectRepairLoop(
  db: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<RepairLoopVerdict> {
  try {
    const rows = await listRecentToolCallOutputs(db, { tenant_id, conversation_id }, 8);
    return tallyRepairSignals(rows);
  } catch {
    return { tripped: false, recent_codes: [], tripped_codes: [] };
  }
}
