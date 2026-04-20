// Deterministic waits for tests. No `setTimeout` — only microtask/tick
// flushes. This lets tests poll async state without depending on wall
// clock, which matters because Bun's fake-timer support is incomplete
// (as of 1.3.x, setSystemTime works but advanceTimersByTime does not).

/** Flush the microtask queue and one macrotask tick. Equivalent to
 *  `await new Promise(r => setImmediate(r))`. */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export interface WaitForOpts {
  /** Maximum poll attempts. Each attempt = one `flush()` + predicate. */
  tries?: number;
  /** Human-readable label for the timeout error. */
  label?: string;
}

/** Poll `predicate` across microtasks until it returns truthy or
 *  `tries` is reached. Throws on timeout. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { tries = 200, label = "waitFor" }: WaitForOpts = {},
): Promise<NonNullable<T>> {
  for (let i = 0; i < tries; i++) {
    const v = await predicate();
    if (v) return v as NonNullable<T>;
    await flush();
  }
  throw new Error(`${label} timed out after ${tries} polls`);
}

/** Fetch JSON repeatedly until `predicate` accepts the parsed body.
 *  Used by journey tests to replace wall-clock deadline loops. */
export async function waitForJson<T>(
  doFetch: () => Promise<Response>,
  predicate: (body: T) => boolean,
  { tries = 200, label = "waitForJson" }: WaitForOpts = {},
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const res = await doFetch();
    if (res.ok) {
      const body = (await res.json()) as T;
      last = body;
      if (predicate(body)) return body;
    }
    await flush();
  }
  const tail = last === undefined ? "<no body>" : JSON.stringify(last).slice(0, 500);
  throw new Error(`${label} timed out after ${tries} polls. last=${tail}`);
}

/** Wait until a predicate on a fetched REST resource is satisfied.
 *  Convenience that builds on waitForJson with a bearer-auth Response. */
export async function waitForResource<T>(
  url: string,
  init: RequestInit,
  predicate: (body: T) => boolean,
  opts?: WaitForOpts,
): Promise<T> {
  return waitForJson<T>(() => fetch(url, init), predicate, opts);
}
