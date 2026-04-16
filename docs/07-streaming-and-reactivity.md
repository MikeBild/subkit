# 07 — Streaming and Reactivity

The engine streams data in exactly two places: out to clients (SSE responses, MCP progress notifications, chat progressive edits) and across in-process boundaries (LISTEN wake-ups fanning out to subscribers, AI SDK token streams piped into HTTP responses). It uses native `ReadableStream`, `TransformStream`, and `async function*` for both.

## Why no RxJS

**Trade-off**: native Web Streams plus AsyncIterables cover every streaming pattern the engine actually needs at the cost of giving up RxJS operator algebra; in exchange, the engine drops a substantial dependency, a learning curve, and a parallel mental model that does not compose with `fetch`, Hono, the AI SDK, or pg-boss out of the box.

The engine deliberately does **not** adopt RxJS or any other reactive-programming library. The reasons are concrete:

- Every primitive the engine talks to (Bun's `fetch`, Hono's `streamSSE`, the Vercel AI SDK, the MCP SDK, pg-boss subscriptions) speaks `ReadableStream` and AsyncIterable natively. Adapting them into Observables and back again is pure ceremony.
- The patterns the engine needs are small and stable: queue-to-iterable, AI-stream-to-SSE, AI-stream-with-side-channel, in-process emitter. None of them require operator chains.
- Backpressure on `ReadableStream` is structural (`desiredSize`, awaited writes), and async iterators pause naturally on awaited consumers. There is no need for `throttleTime`, `bufferTime`, or `concatMap` because the producer never outruns the consumer in the first place.
- Debuggability matters more than concision. A stack trace through an `async function*` lands on a line of code; a stack trace through a long Rx pipeline lands inside the operator machinery.

The engine therefore reaches for four small patterns and stops there.

## Pattern 1 — pg-boss subscription as AsyncIterable

A pg-boss subscription is push-based: pg-boss invokes a callback when a job arrives. The engine wraps that callback in a small bounded queue and exposes the result as an `AsyncIterable` so consumers can `for await` over jobs without inverting their control flow.

```ts
async function* subscribe<T>(
  boss: PgBoss,
  queue: string,
): AsyncIterable<PgBoss.Job<T>> {
  // bounded buffer so a slow consumer applies backpressure upstream
  const pending: PgBoss.Job<T>[] = [];
  let waiting: ((job: PgBoss.Job<T>) => void) | null = null;

  await boss.work<T>(queue, async (job) => {
    if (waiting) { waiting(job); waiting = null; }
    else pending.push(job);
  });

  while (true) {
    if (pending.length > 0) yield pending.shift()!;
    else yield await new Promise<PgBoss.Job<T>>((r) => (waiting = r));
  }
}

// usage
for await (const job of subscribe<RunPayload>(boss, "execution.run")) {
  await runExecution(job.data);
}
```

A real implementation also wires `AbortSignal` into the loop and rejects pending awaits on shutdown so graceful drain works.

## Pattern 2 — AI SDK `streamText` into SSE via Hono

The Vercel AI SDK's `streamText` returns an object with token, tool-call, and finish parts. Hono's `streamSSE` helper takes a writer callback and handles the SSE framing. The bridge is one `for await` loop.

```ts
import { streamText } from "ai";
import { streamSSE } from "hono/streaming";

app.post("/v1/conversations/:id/turns", (c) =>
  streamSSE(c, async (sse) => {
    const result = streamText({
      model: resolveModel(c),
      messages: await loadHistory(c.req.param("id")),
    });

    for await (const part of result.fullStream) {
      // one SSE event per part, typed by kind
      await sse.writeSSE({
        event: part.type,            // "text-delta" | "tool-call" | "finish" | ...
        data: JSON.stringify(part),
      });
    }
  }),
);
```

`streamSSE` honors client disconnect: when the consumer goes away, the SSE writer rejects the next `writeSSE`, the `for await` loop unwinds, and the AI SDK's underlying `fetch` is aborted via the same `AbortController` Hono propagates.

## Pattern 3 — AI stream composed with an MCP progress side channel

When the same Conversation turn is exposed over MCP rather than REST, the engine still streams the AI tokens, but the transport is `notifications/progress` messages on the MCP session, with the final assistant message returned as the `tools/call` result. The producer is the same `result.fullStream`; only the sink differs.

```ts
async function streamTurnOverMcp(
  session: McpServerSession,
  progressToken: string | number,
  result: ReturnType<typeof streamText>,
): Promise<string> {
  let assembled = "";

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      assembled += part.textDelta;
      // side channel: progress notification carrying the cumulative text
      await session.sendNotification("notifications/progress", {
        progressToken,
        progress: assembled.length,
        message: part.textDelta,
      });
    }
  }
  return assembled; // returned as the tools/call result body
}
```

The same `streamText` value can drive both an SSE response and an MCP progress channel because `fullStream` is consumed exactly once per turn — the engine picks the sink based on which transport opened the Conversation.

## Pattern 4 — typed in-process emitter for LISTEN/NOTIFY fan-out

The dedicated `pg.Client` listener (see `06-queue-scheduler-pubsub.md`) decodes one Event row and needs to fan it out to every in-process subscriber: an SSE handler streaming `execution.status`, a Conversation streaming over MCP, the chat delivery dispatcher. The engine uses a small typed emitter built on `Map<channel, Set<handler>>` rather than `EventEmitter` (untyped) or RxJS `Subject` (heavy).

```ts
type Handler<T> = (payload: T) => void | Promise<void>;

class Bus<Events extends Record<string, unknown>> {
  private channels = new Map<keyof Events, Set<Handler<unknown>>>();

  on<K extends keyof Events>(channel: K, handler: Handler<Events[K]>): () => void {
    const set = this.channels.get(channel) ?? new Set();
    set.add(handler as Handler<unknown>);
    this.channels.set(channel, set);
    return () => set.delete(handler as Handler<unknown>);
  }

  async emit<K extends keyof Events>(channel: K, payload: Events[K]): Promise<void> {
    const set = this.channels.get(channel);
    if (!set) return;
    // sequential: a slow handler blocks siblings, which is the whole point
    for (const h of set) await h(payload);
  }
}
```

Subscribers receive a strongly typed payload because `Events` is a discriminated record. Sequential dispatch is intentional: a slow consumer applies backpressure to the listener, which in turn applies backpressure to the catch-up drain, which in turn keeps the engine from buffering an unbounded queue of pending fan-outs in memory.

## Backpressure

Backpressure in the engine is structural and requires no operators:

- `ReadableStream` exposes `desiredSize` on its controller; when a consumer is slow, `desiredSize` goes negative and producers either pause or are prevented from enqueuing. Hono's `streamSSE` writer awaits the underlying socket, so a slow client naturally throttles the loop above it.
- `async function*` generators are lazy: the next iteration runs only when the consumer awaits it. A producer driven by a `for await` loop cannot outrun the consumer.
- The bounded queue in pattern 1 and the sequential dispatch in pattern 4 carry the same property end-to-end: from pg-boss callback through the in-process bus through every SSE writer, no link in the chain produces faster than the slowest downstream consumer accepts.

There is no explicit flow-control operator anywhere in the engine. The data path is the flow control.
