import { AsyncLocalStorage } from "node:async_hooks";
import type { CredentialUseSnapshot } from "../../credentials/index.ts";

const observers = new AsyncLocalStorage<{
  active: boolean;
  observe: (snapshot: CredentialUseSnapshot) => Promise<void>;
  generations: Map<string, { generation: number; credential_id?: string }>;
}>();

export function withMcpCredentialObserver<T>(
  observer: ((snapshot: CredentialUseSnapshot) => Promise<void>) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!observer && observers.getStore()?.active) return operation();
  const context = {
    active: true,
    observe: observer ?? (async () => {}),
    generations: new Map<string, { generation: number; credential_id?: string }>(),
  };
  return observers.run(context, async () => {
    try {
      return await operation();
    } finally {
      context.active = false;
    }
  });
}

export function captureMcpCredentialGeneration(
  connector_id: string,
  generation: number,
  credential_id?: string,
): void {
  observers
    .getStore()
    ?.generations.set(connector_id, { generation, ...(credential_id ? { credential_id } : {}) });
}

export function observedMcpCredentialGeneration(connector_id: string): number | undefined {
  return observers.getStore()?.generations.get(connector_id)?.generation;
}

export async function observeMcpCredential(snapshot: CredentialUseSnapshot | null): Promise<void> {
  const context = observers.getStore();
  if (snapshot && context?.active) await context.observe(snapshot);
}

export function observedMcpCredentialId(connector_id: string): string | undefined {
  return observers.getStore()?.generations.get(connector_id)?.credential_id;
}
