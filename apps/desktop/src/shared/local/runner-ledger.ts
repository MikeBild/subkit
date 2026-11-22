import {
  type DeviceCommand,
  DeviceCommandSchema,
  type DeviceResult,
  DeviceResultSchema,
} from "@shared/device/protocol.ts";
import { z } from "zod";
import { refused } from "./files-policy.ts";

export const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const LedgerEntrySchema = z
  .object({
    command_id: z.string().min(1),
    result: DeviceResultSchema,
    finished_at: z.number().int().nonnegative(),
    replay: DeviceCommandSchema.optional(),
    undelivered: z.literal(true).optional(),
  })
  .strict();

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type Ledger = readonly LedgerEntry[];

const CONTENT_KINDS: ReadonlySet<DeviceCommand["kind"]> = new Set(["files.read_text"]);

export function parseLedger(raw: unknown): Ledger {
  if (!Array.isArray(raw)) return [];
  const entries: LedgerEntry[] = [];
  for (const item of raw) {
    const parsed = LedgerEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

export function recallEntry(ledger: Ledger, commandId: string): LedgerEntry | null {
  return ledger.find((entry) => entry.command_id === commandId) ?? null;
}

export function recall(ledger: Ledger, commandId: string): DeviceResult | null {
  return recallEntry(ledger, commandId)?.result ?? null;
}

export function prune(ledger: Ledger, now: number): Ledger {
  return ledger.filter((entry) => now - entry.finished_at < LEDGER_RETENTION_MS);
}

function metadataOnly(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== "object") return {};
  const { size, sha256 } = output as { size?: unknown; sha256?: unknown };
  return {
    ...(typeof size === "number" ? { size } : {}),
    ...(typeof sha256 === "string" ? { sha256 } : {}),
  };
}

export function ledgerForm(
  command: DeviceCommand | null,
  result: DeviceResult,
): Pick<LedgerEntry, "result" | "replay"> {
  if (!command || !CONTENT_KINDS.has(command.kind) || result.status !== "done") return { result };
  return {
    result: { status: "done", output: metadataOnly(result.output), evidence: result.evidence },
    replay: command,
  };
}

export function replayVerdict(stored: DeviceResult, fresh: DeviceResult): DeviceResult {
  if (fresh.status !== "done" || stored.status !== "done") return fresh;
  const same =
    fresh.evidence.after_version !== undefined &&
    fresh.evidence.after_version === stored.evidence.after_version;
  return same ? fresh : refused("stale");
}

export function remember(
  ledger: Ledger,
  commandId: string,
  result: DeviceResult,
  now: number,
  command: DeviceCommand | null = null,
): Ledger {
  if (recall(ledger, commandId)) return prune(ledger, now);
  return [
    ...prune(ledger, now),
    { command_id: commandId, ...ledgerForm(command, result), finished_at: now, undelivered: true },
  ];
}

export function markDelivered(ledger: Ledger, commandId: string): Ledger {
  return ledger.map((entry) => {
    if (entry.command_id !== commandId || !entry.undelivered) return entry;
    const { undelivered: _, ...delivered } = entry;
    return delivered;
  });
}

export function undeliveredIds(ledger: Ledger): string[] {
  return ledger.filter((entry) => entry.undelivered).map((entry) => entry.command_id);
}
