const tails = new Map<string, Promise<unknown>>();

export async function withConversationTurnLock<T>(
  tenant_id: string,
  conversation_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${tenant_id}:${conversation_id}`;
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

export function _turnLockSizeForTests(): number {
  return tails.size;
}
