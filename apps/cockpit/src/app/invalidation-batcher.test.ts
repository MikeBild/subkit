import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { QueryClient, type QueryKey, QueryObserver } from "@tanstack/react-query";
import {
  createInvalidationBatcher,
  INVALIDATION_MAX_WAIT_MS,
  INVALIDATION_QUIET_MS,
  type InvalidationBatcher,
} from "./invalidation-batcher";
import { keysForEvent } from "./live-invalidation";

interface Watched {
  fetches: string[];
  release: () => void;
}

let client: QueryClient;
let batcher: InvalidationBatcher;
let stops: (() => void)[];
let gate: Promise<void> | null;
let open: (() => void) | null;

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

function watch(key: QueryKey, log: string[]): Watched {
  const observer = new QueryObserver(client, {
    queryKey: key,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      log.push(JSON.stringify(key));
      if (gate) await gate;
      return log.length;
    },
  });
  stops.push(observer.subscribe(() => undefined));
  return { fetches: log, release: () => open?.() };
}

function hold(): void {
  gate = new Promise((resolve) => {
    open = () => {
      gate = null;
      open = null;
      resolve();
    };
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  batcher = createInvalidationBatcher(client);
  stops = [];
  gate = null;
  open = null;
});

afterEach(() => {
  for (const stop of stops) stop();
  batcher.dispose();
  client.clear();
  jest.useRealTimers();
});

describe("coalescing live invalidations", () => {
  test("a burst of 20 events fetches the attention list exactly once", async () => {
    const log: string[] = [];
    watch(["attention"], log);
    await settle();
    log.length = 0;

    for (let event = 0; event < 20; event += 1) {
      batcher.schedule(
        keysForEvent(event % 2 ? "execution.completed" : "connector.health_changed"),
      );
      jest.advanceTimersByTime(50);
      await settle();
    }
    expect(log).toEqual([]);

    jest.advanceTimersByTime(INVALIDATION_QUIET_MS);
    await settle();
    expect(log).toEqual(['["attention"]']);
  });

  test("a steady stream still refreshes, at most once per maximum wait", async () => {
    const log: string[] = [];
    watch(["attention"], log);
    await settle();
    log.length = 0;

    const ticks = INVALIDATION_MAX_WAIT_MS / 100;
    for (let tick = 0; tick < ticks; tick += 1) {
      batcher.schedule([["attention"]]);
      jest.advanceTimersByTime(100);
      await settle();
    }
    expect(log).toEqual(['["attention"]']);
  });

  test("keys are refreshed in the order they first arrived, each once", async () => {
    const log: string[] = [];
    watch(["runs"], log);
    watch(["attention"], log);
    watch(["decisions"], log);
    await settle();
    log.length = 0;

    batcher.schedule([["decisions"], ["attention"]]);
    batcher.schedule([["runs"], ["decisions"]]);
    batcher.schedule([["attention"]]);
    jest.advanceTimersByTime(INVALIDATION_QUIET_MS);
    await settle();
    expect(log).toEqual(['["decisions"]', '["attention"]', '["runs"]']);
  });

  test("an event during a running fetch starts no second fetch, then exactly one follow-up", async () => {
    const log: string[] = [];
    const attention = watch(["attention"], log);
    await settle();
    log.length = 0;

    hold();
    batcher.schedule([["attention"]]);
    jest.advanceTimersByTime(INVALIDATION_QUIET_MS);
    await settle();
    expect(log).toEqual(['["attention"]']);

    batcher.schedule([["attention"]]);
    jest.advanceTimersByTime(INVALIDATION_QUIET_MS);
    await settle();
    batcher.schedule([["attention"]]);
    jest.advanceTimersByTime(INVALIDATION_QUIET_MS);
    await settle();
    expect(log).toEqual(['["attention"]']);

    attention.release();
    await settle();
    expect(log).toEqual(['["attention"]', '["attention"]']);

    jest.advanceTimersByTime(INVALIDATION_MAX_WAIT_MS);
    await settle();
    expect(log).toHaveLength(2);
  });

  test("an immediate refresh drops the pending one for the same key", async () => {
    const log: string[] = [];
    watch(["attention"], log);
    await settle();
    log.length = 0;

    batcher.schedule([["attention"]]);
    await batcher.now([["attention"]]);
    expect(log).toEqual(['["attention"]']);

    jest.advanceTimersByTime(INVALIDATION_MAX_WAIT_MS);
    await settle();
    expect(log).toEqual(['["attention"]']);
  });

  test("a truncated stream refreshes everything once and drops what was pending", async () => {
    const log: string[] = [];
    watch(["attention"], log);
    watch(["runs"], log);
    await settle();
    log.length = 0;

    batcher.schedule([["attention"]]);
    batcher.everything();
    await settle();
    expect([...log].sort()).toEqual(['["attention"]', '["runs"]']);

    jest.advanceTimersByTime(INVALIDATION_MAX_WAIT_MS);
    await settle();
    expect(log).toHaveLength(2);
  });
});
