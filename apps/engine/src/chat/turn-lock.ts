// Per-conversation turn serialization for the chat surface.
//
// A shared space maps to ONE persistent conversation, so two members
// mentioning the bot at (nearly) the same time produce two `chat.event`
// jobs targeting the same conversation_id. pg-boss workers process them
// concurrently, and nothing in the conversation layer serializes turns —
// `registerConversationAbort` is an abort registry, not a mutex. Two
// interleaved `runConversationTurn`s on one conversation corrupt the
// message timeline (both read the same history, both append).
//
// This is a process-local promise-chain keyed by
// `${tenant_id}:${conversation_id}` — sufficient because the engine runs
// single-instance (systemd binary) and every chat turn dispatches inside
// this process. The chain tail is dropped as soon as the last holder
// finishes, so the map never grows past the set of actively-chatting
// conversations. Errors propagate to the caller but never poison the
// chain (the next waiter sees a resolved tail).

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively for `(tenant_id, conversation_id)` — queued
 * behind any in-flight turn for the same conversation, concurrent with
 * everything else.
 */
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

/** Test-only: number of conversations currently holding/awaiting a lock. */
export function _turnLockSizeForTests(): number {
  return tails.size;
}
