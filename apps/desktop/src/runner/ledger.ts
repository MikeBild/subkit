import type { DeviceCommand, DeviceResult } from "@shared/device/protocol.ts";
import { readJson, writeJsonAtomic } from "../main/store.ts";
import {
  type Ledger,
  type LedgerEntry,
  markDelivered,
  parseLedger,
  prune,
  recallEntry,
  remember,
  undeliveredIds,
} from "../shared/local/runner-ledger.ts";

export interface RunnerLedger {
  recall(commandId: string): LedgerEntry | null;
  remember(commandId: string, result: DeviceResult, command: DeviceCommand | null): void;
  delivered(commandId: string): void;
  undelivered(): string[];
}

export function openLedger(path: string, now: () => number): RunnerLedger {
  let ledger: Ledger = prune(parseLedger(readJson(path)), now());
  return {
    recall: (commandId) => recallEntry(ledger, commandId),
    remember(commandId, result, command) {
      ledger = remember(ledger, commandId, result, now(), command);
      writeJsonAtomic(path, ledger);
    },
    delivered(commandId) {
      const next = markDelivered(ledger, commandId);
      if (undeliveredIds(next).length === undeliveredIds(ledger).length) return;
      ledger = next;
      writeJsonAtomic(path, ledger);
    },
    undelivered: () => undeliveredIds(ledger),
  };
}
