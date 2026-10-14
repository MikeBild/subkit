const receiptName =
  /^browser-chat-ownership-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recoverOwnedConversationReceipts({
  directory,
  instance,
  databaseGeneration,
  tenantId,
  ownerId,
  readDirectory,
  readFile,
  lstat,
  unlink,
  cleanup,
}) {
  const entries = await readDirectory(directory, { withFileTypes: true });
  const failures = [];
  let cleaned = 0;
  for (const entry of entries) {
    const match = receiptName.exec(entry.name);
    if (!match) continue;
    const path = `${directory}/${entry.name}`;
    try {
      if (!entry.isFile()) throw new Error("receipt is not a regular file");
      const file = await lstat(path);
      if (!file.isFile() || file.nlink !== 1) throw new Error("receipt file identity is unsafe");
      const receipt = JSON.parse(await readFile(path, "utf8"));
      if (
        receipt?.schema !== "subkit-local-chat-ownership-v1" ||
        !uuid.test(receipt.runId ?? "") ||
        receipt.runId.toLowerCase() !== match[1].toLowerCase() ||
        !uuid.test(receipt.id ?? "")
      )
        throw new Error("receipt schema, run ID, or conversation ID is invalid");
      if (
        receipt.instance !== instance ||
        receipt.databaseGeneration !== databaseGeneration ||
        receipt.tenantId !== tenantId ||
        receipt.ownerId !== ownerId
      )
        throw new Error("receipt belongs to a different or superseded local identity");
      await cleanup(receipt.id, receipt);
      await unlink(path);
      cleaned += 1;
    } catch (error) {
      failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { cleaned, failures };
}
