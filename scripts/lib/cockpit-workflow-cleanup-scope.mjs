export function shouldLoadBrowserWorkflowCleanup({
  readOnly,
  chatOnly,
  workspaceOnly,
  cleanupOnly,
  apiReceiptPresent,
  browserReceiptPresent,
}) {
  if (readOnly || chatOnly || workspaceOnly) return false;
  if (cleanupOnly && !apiReceiptPresent && !browserReceiptPresent) return false;
  if (cleanupOnly && apiReceiptPresent !== browserReceiptPresent)
    throw new Error("Incomplete browser workflow cleanup receipts");
  return true;
}
