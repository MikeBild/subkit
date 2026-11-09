import { expect, test } from "bun:test";
import { createEmbeddingWorkerClient } from "../worker-client.ts";
import type { EmbeddingRequest, EmbeddingResponse } from "../worker-protocol.ts";

function fixture(options: { maxPending?: number; timeoutMs?: number } = {}) {
  const events = new Map<string, () => void>();
  const sent: EmbeddingRequest[] = [];
  let references = 0;
  let terminated = 0;
  const worker = {
    onmessage: null as ((event: MessageEvent<EmbeddingResponse>) => void) | null,
    onerror: null as (() => void) | null,
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
    postMessage: (message: EmbeddingRequest) => sent.push(message),
    ref: () => references++,
    unref: () => references--,
    terminate: () => terminated++,
  };
  const client = createEmbeddingWorkerClient(() => worker as unknown as Bun.Worker, options);
  return {
    client,
    sent,
    worker,
    open: () => events.get("open")?.(),
    reply: (response: EmbeddingResponse) =>
      worker.onmessage?.({ data: response } as MessageEvent<EmbeddingResponse>),
    stopped: () => terminated,
    references: () => references,
  };
}

test("queues requests until worker startup and correlates out-of-order replies", async () => {
  const f = fixture();
  const available = f.client.available();
  const vectors = f.client.embed(["first", "second"]);
  expect(f.sent).toHaveLength(0);
  f.open();
  expect(f.sent).toEqual([
    { id: 1, kind: "available" },
    { id: 2, kind: "embed", texts: ["first", "second"] },
  ]);
  f.reply({ id: 99, kind: "failed" });
  f.reply({ id: 2, kind: "embed", vectors: [[1], [2]] });
  f.reply({ id: 1, kind: "available", available: true });
  expect(await available).toBe(true);
  expect(await vectors).toEqual([[1], [2]]);
  const next = f.client.embed(["third"]);
  expect(f.sent.at(-1)).toEqual({ id: 3, kind: "embed", texts: ["third"] });
  f.reply({ id: 3, kind: "embed", vectors: [[3]] });
  expect(await next).toEqual([[3]]);
});

test("worker failure settles all callers and preserves FTS fallback", async () => {
  const f = fixture();
  const available = f.client.available();
  const vectors = f.client.embed(["secret input must not appear in logs"]);
  f.open();
  f.worker.onerror?.();
  expect(await available).toBe(false);
  expect(await vectors).toEqual([]);
  expect(await f.client.embed(["next"])).toEqual([]);
  expect(f.stopped()).toBe(1);
});

test("empty input allocates no worker; input copy is bounded and queue overload falls back", async () => {
  const f = fixture({ maxPending: 1 });
  expect(await f.client.embed([])).toEqual([]);
  const large = "x".repeat(10000);
  const embedding = f.client.embed([large, "small"]);
  expect(await f.client.available()).toBe(false);
  f.open();
  expect(f.sent).toEqual([{ id: 1, kind: "embed", texts: [large.slice(0, 8192), "small"] }]);
  expect(large).toHaveLength(10000);
  f.reply({ id: 1, kind: "failed" });
  expect(await embedding).toEqual([]);
});

test("an unresponsive worker cannot leave callers pending indefinitely", async () => {
  const f = fixture({ timeoutMs: 10 });
  const response = f.client.available();
  f.open();
  expect(await response).toBe(false);
  expect(f.stopped()).toBe(1);
});

test("failed worker startup falls back without propagating infrastructure errors", async () => {
  const client = createEmbeddingWorkerClient(() => {
    throw new Error("worker startup");
  });
  expect(await client.available()).toBe(false);
  expect(await client.embed(["text"])).toEqual([]);
});
