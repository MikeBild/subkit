export async function deleteOwnedConversation({
  id,
  receipt,
  selectedInstance,
  currentInstance,
  tenantId,
  ownerId,
  headers,
  request,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (
    !/^[0-9a-f-]{36}$/i.test(id ?? "") ||
    id !== receipt?.id ||
    !selectedInstance ||
    JSON.stringify(selectedInstance) !== JSON.stringify(currentInstance) ||
    receipt.instance !== selectedInstance.key ||
    receipt.databaseGeneration !== selectedInstance.databaseGeneration ||
    receipt.tenantId !== tenantId ||
    receipt.ownerId !== ownerId
  )
    throw new Error(
      "Owned conversation cleanup identity does not match the selected local instance",
    );

  const path = `/v1/conversations/${encodeURIComponent(id)}`;
  let response = await request.delete(path, { headers });
  if (response.status() === 404) return { deleted: true, alreadyMissing: true };
  if (response.status() !== 409)
    throw new Error(`Owned conversation cleanup failed: HTTP ${response.status()}`);

  const cancelled = await request.post(`${path}/cancel`, { headers });
  if (!cancelled.ok() && cancelled.status() !== 404)
    throw new Error(`Owned conversation cancellation failed: HTTP ${cancelled.status()}`);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(Math.min(250 * (attempt + 1), 1000));
    response = await request.delete(path, { headers });
    if (response.ok()) return { deleted: true, alreadyMissing: false };
    if (response.status() === 404) return { deleted: true, alreadyMissing: true };
    if (response.status() !== 409)
      throw new Error(`Owned conversation cleanup retry failed: HTTP ${response.status()}`);
  }
  throw new Error("Owned conversation cleanup remained busy after bounded retries");
}
