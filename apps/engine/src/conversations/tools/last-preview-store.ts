// Per-conversation cache of the most recent successful `dry_run_workflow`
// scope.
//
// Pre-fix: the LLM author had no way to iterate on a JSONata transform
// without re-running the entire upstream chain. `dry_run_transform`
// exists to evaluate a transform against arbitrary `sample_data`, but it
// rejected scope-reference strings (`$scope.fetch.data`) outright with a
// hint to "paste real data here." The author then fell back to
// `dry_run_workflow`, which hit the live upstream again. Session
// fb930dcb burned twelve identical 128 KB Jira fetches that way.
//
// This module exposes the per-conversation scope so `dry_run_transform`
// can resolve `$scope` / `$scope.<step_id>` references from the latest
// preview — no upstream call, JSONata-only iteration.
//
// Scope: process-local, keyed on `(tenant_id, conversation_id)`. 5 min
// TTL — matches the dry-run cache TTL. Multi-instance engines miss the
// shared benefit; that is acceptable for the authoring path.

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

/** Test helper — wipes the store. Not exported through the public surface. */
export function __resetLastPreviewStoreForTest(): void {
  store.clear();
}
