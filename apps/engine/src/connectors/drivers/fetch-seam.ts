import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../../logging/logger.ts";

const LOAD_TIME_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

const KEEPALIVE_POLICY = false as const;

const DRIVER_FETCH: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.keepalive === true) {
      logger.warn({
        module: "driver",
        action: "fetch.keepalive_override",
        msg: "caller requested keepalive:true but driver egress forces keepalive:false (pooled-connection poisoning guard, fetch-seam.ts)",
      });
    }
    return LOAD_TIME_FETCH(input, { ...(init ?? {}), keepalive: KEEPALIVE_POLICY });
  },
  { preconnect: globalThis.fetch.preconnect?.bind(globalThis) ?? (() => {}) },
);

const overrideStore = new AsyncLocalStorage<typeof fetch>();

export function getDriverFetch(): typeof fetch {
  return overrideStore.getStore() ?? DRIVER_FETCH;
}

export function _withDriverFetchForTests<T>(
  fn: typeof fetch | null,
  body: () => Promise<T>,
): Promise<T> {
  return withDriverFetch(fn, body);
}

export function withDriverFetch<T>(fn: typeof fetch | null, body: () => Promise<T>): Promise<T> {
  return overrideStore.run(fn ?? LOAD_TIME_FETCH, body);
}
