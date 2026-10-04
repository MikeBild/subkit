export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export interface WaitForOpts {
  tries?: number;
  label?: string;
  sleepMs?: number;
}

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { tries = 200, label = "waitFor", sleepMs = 0 }: WaitForOpts = {},
): Promise<NonNullable<T>> {
  for (let i = 0; i < tries; i++) {
    const v = await predicate();
    if (v) return v as NonNullable<T>;
    if (sleepMs > 0) {
      // allow-wall-clock: I/O-bound polling — callers opt into real
      // time when they need it (queue workers, network handshakes).
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    } else {
      await flush();
    }
  }
  throw new Error(`${label} timed out after ${tries} polls`);
}

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

export async function waitForResource<T>(
  url: string,
  init: RequestInit,
  predicate: (body: T) => boolean,
  opts?: WaitForOpts,
): Promise<T> {
  return waitForJson<T>(() => fetch(url, init), predicate, opts);
}
