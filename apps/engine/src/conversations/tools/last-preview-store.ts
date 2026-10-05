const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 256;

interface PreviewSlot {
  scope: Record<string, unknown>;
  input: unknown;
  expiresAt: number;
}

const store = new Map<string, PreviewSlot>();

function keyFor(tenant_id: string, conversation_id: string): string {
  return `${tenant_id}::${conversation_id}`;
}

export function recordLastPreview(opts: {
  tenant_id: string;
  conversation_id: string;
  scope: Record<string, unknown>;
  input: unknown;
}): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(keyFor(opts.tenant_id, opts.conversation_id), {
    scope: opts.scope,
    input: opts.input,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function getLastPreview(opts: {
  tenant_id: string;
  conversation_id: string;
}): { scope: Record<string, unknown>; input: unknown } | null {
  const k = keyFor(opts.tenant_id, opts.conversation_id);
  const slot = store.get(k);
  if (!slot) return null;
  if (slot.expiresAt < Date.now()) {
    store.delete(k);
    return null;
  }
  return { scope: slot.scope, input: slot.input };
}

export function clearLastPreview(opts: { tenant_id: string; conversation_id: string }): void {
  store.delete(keyFor(opts.tenant_id, opts.conversation_id));
}

export function __resetLastPreviewStoreForTest(): void {
  store.clear();
}
