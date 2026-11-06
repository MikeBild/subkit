export const RECEIPT_PURGE_BATCH = 500;

export interface RetainedReceipt {
  id: string;
  status: string;
  expires_at: Date;
}

export function receiptIsSpent(receipt: RetainedReceipt, now: Date): boolean {
  return receipt.status === "completed" || receipt.expires_at.getTime() <= now.getTime();
}

export function receiptsToPurge(
  receipts: ReadonlyArray<RetainedReceipt>,
  now: Date,
  keepId: string | null = null,
): string[] {
  return receipts
    .filter((receipt) => receipt.id !== keepId && receiptIsSpent(receipt, now))
    .slice(0, RECEIPT_PURGE_BATCH)
    .map((receipt) => receipt.id);
}
