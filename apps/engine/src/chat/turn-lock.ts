import { ConversationTurnInProgressError } from "../conversations/turns.ts";

const tails = new Map<string, Promise<unknown>>();

export async function withConversationTurnLock<T>(
  tenant_id: string,
  conversation_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${tenant_id}:${conversation_id}`;
  if (tails.has(key)) throw new ConversationTurnInProgressError();
  const marker = Promise.resolve();
  tails.set(key, marker);
  try {
    return await fn();
  } finally {
    if (tails.get(key) === marker) tails.delete(key);
  }
}

export function _turnLockSizeForTests(): number {
  return tails.size;
}
