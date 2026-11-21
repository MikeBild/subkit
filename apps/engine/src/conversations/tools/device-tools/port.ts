import type { Db } from "../../../db/client.ts";
import type { LocalConfirmationPort } from "../../../devices/confirmation-port.ts";
import { loadPendingCommand } from "../../device-tool-store.ts";
import { updateToolCallOutput } from "../../persistence/index.ts";
import { dispatchPending } from "./run.ts";

export function deviceConfirmationPort(db: Db): LocalConfirmationPort {
  return {
    async settled(outcome) {
      if (outcome.state !== "granted") return;
      const loaded = await loadPendingCommand(db, outcome.tenant_id, outcome.confirmation_id);
      if (!loaded || loaded.pending.command_id !== outcome.confirmation.command_id) return;
      const output = await dispatchPending(db, {
        tenant_id: outcome.tenant_id,
        tool_call_id: outcome.confirmation_id,
        pending: loaded.pending,
        signal: new AbortController().signal,
        recheck: true,
      });
      await updateToolCallOutput(
        db,
        outcome.confirmation_id,
        output.ok ? output.data : output,
        output.ok ? "ok" : "error",
      );
    },
  };
}
