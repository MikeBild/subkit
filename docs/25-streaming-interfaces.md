# 25 — Streaming Interfaces

The engine streams in three places: Conversation turns, Execution progress, and the tenant-wide Event tail. **Server-Sent Events over HTTP is the canonical streaming surface** for all three. WebSockets appear only on the Tunnel surface because tunnel framing genuinely needs bidirectional traffic. MCP has its own parallel streaming model (Streamable HTTP transport with `notifications/progress`) covered in `12-mcp-server.md`; this file does not repeat that material.

## Why SSE for everything user-facing

| Concern | SSE | WebSocket |
|---|---|---|
| Direction | Server to client only | Bidirectional |
| Protocol | Plain HTTP, one long-lived response | Upgrade handshake, custom framing |
| Proxy and firewall friendliness | Excellent — looks like a slow HTTP request | Frequently blocked or downgraded |
| Reconnect | Native via `EventSource` and `Last-Event-ID` | Custom |
| Backpressure | Native HTTP backpressure | Manual |
| Auth | Same `Authorization: Bearer` flow as the rest of the REST surface | Often a separate query-string token |
| Implementation cost | Hono's `streamSSE` helper, ~10 lines per endpoint | A framing layer, ping/pong, reconnect logic |

Trade-off: the engine never asks the client to send anything mid-stream over the same channel — turn submissions, approvals, and cancellations all go through normal REST POST endpoints. That asymmetry is exactly what SSE is designed for, and it removes an entire class of "what if the socket drops mid-frame" bugs.

## Endpoints that stream

| Endpoint | Stream contents |
|---|---|
| `GET /v1/conversations/:id/stream` | Conversation turns, structured-intent tool calls, draft mutations, and approval-required pauses for the targeted Conversation. |
| `GET /v1/executions/:id/stream` | Execution lifecycle events: `queued`, `running`, per-Step transitions, log lines, and the terminal `succeeded` / `failed` / `aborted` / `timed_out` event. |
| `GET /v1/events/stream` | Tenant-wide Event tail filtered by an optional `event_pattern` query parameter. The same outbox feed that drives Subscriptions, but read directly. |

All three endpoints walk the same Auth Provider chain as the rest of REST. None of them accept query-string credentials.

## Wire format

Standard SSE framing:

```
event: <event-name>
id: <monotonic-event-id>
data: <single-line JSON payload>

```

Rules the engine follows:

1. `event:` is always present and carries the engine event type (e.g. `execution.step.started`).
2. `id:` is always present and is a monotonic id that the client passes back as `Last-Event-ID` on resume. The id is the outbox `events.id` for events that originated there, or a synthesized monotonic id for endpoint-local events (Conversation streams).
3. `data:` is one line of compact JSON. Multi-line bodies are forbidden; clients can rely on one frame per line.
4. The server sends a `:keepalive` comment line every 15 seconds to keep proxies from reaping the connection.
5. The first frame on every stream is a `event: hello` carrying the highest known event id, so a fresh client knows where it is.

Trade-off: a strict one-line-per-event format means clients can split on `\n\n` and parse each `data:` line as JSON without a state machine. A multi-line format would carry slightly less framing overhead per event but force a more complex parser; the simplicity wins.

## Resume semantics

Every stream supports `Last-Event-ID` resume:

```
GET /v1/executions/:id/stream
Last-Event-ID: 8421337
Authorization: Bearer wf_live_...
```

On reconnect with `Last-Event-ID`, the server replays from the next event after that id and continues. The replay reads from the durable source (the outbox for tenant streams, the `execution_steps` table for Execution streams, the `conversation_messages` and `conversation_tool_calls` tables for Conversation streams), so a client that was offline for several minutes still catches up cleanly.

Trade-off: replaying from the durable source — instead of an in-memory ring buffer — means a client can resume after an arbitrarily long disconnect, at the cost of a small extra database read on each reconnect. That trade is correct for an engine where a Conversation might pause for hours waiting on human approval.

## Library

Hono's `streamSSE` helper handles the response-side details: setting `Content-Type: text/event-stream`, flushing the response, and serializing each frame. The engine wraps it in a tiny adapter that takes an `AsyncIterable` of typed events and writes them to the SSE channel.

## Wiring sketch

The streaming endpoint is a pure function from "give me events for this subject" to an `AsyncIterable`, then `streamSSE` writes them out. Resume, keepalive, and shutdown are handled centrally.

```ts
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

type StreamFrame = {
  id: string;
  event: string;
  data: unknown;
};

// Source-of-truth iterable. Could be an outbox tail, an execution feed,
// or an in-memory conversation channel. The endpoint does not care.
type EventSource = AsyncIterable<StreamFrame>;

async function pipeSse(c: Context, source: EventSource) {
  return streamSSE(c, async (sse) => {
    const keepalive = setInterval(() => sse.writeSSE({ data: "" }), 15_000);
    try {
      // Initial frame so the client knows where it joined.
      await sse.writeSSE({ event: "hello", data: JSON.stringify({ ts: Date.now() }) });
      for await (const frame of source) {
        await sse.writeSSE({
          id: frame.id,
          event: frame.event,
          data: JSON.stringify(frame.data),
        });
      }
    } finally {
      clearInterval(keepalive);
    }
  });
}

// Endpoint glue: build the AsyncIterable, hand it to pipeSse.
export async function executionStream(c: Context) {
  const id = c.req.param("id");
  const lastId = c.req.header("Last-Event-ID");
  const source = openExecutionFeed(id, lastId); // returns an AsyncIterable
  return pipeSse(c, source);
}
```

Trade-off: the source is always an `AsyncIterable`, which keeps the endpoint glue small and lets a single `pipeSse` helper serve every stream with the same framing rules. The cost is one layer of indirection between the underlying outbox listener and the wire — that layer is also where backpressure and cancellation are clean to wire up.

## Backpressure and cancellation

`streamSSE` writes are awaited, so a slow client naturally pauses the iterator. Each underlying source supports cooperative cancellation:

| Source | Cancellation |
|---|---|
| Outbox tail | The reader unsubscribes from the in-process emitter on iterator return. |
| Execution feed | The Execution's `AbortController` fires on disconnect, telling the iterator to clean up. |
| Conversation feed | The per-Conversation channel removes the listener and discards any buffered frames. |

Trade-off: cooperative cleanup keeps backpressure honest — a client with a stuck network does not balloon server memory because the iterator is paused at the same boundary the slow client is paused at.

## WebSockets and where they appear

WebSockets appear in exactly **one** place: the Tunnel surface. The Tunnel agent opens a persistent outbound WebSocket from inside the customer network to `PUBLIC_BASE_URL`, registers its target names, and then the engine routes selected Connector requests through that socket. Bidirectional framing is required because the engine sends `request` frames into the customer network and receives matching `response` frames back.

Trade-off: WebSockets are the right tool for tunnel framing because the protocol is genuinely bidirectional and the agent's environment is one we control end to end. They would be the wrong tool for user-facing streams because user environments include corporate proxies, load balancers, and browser tabs — every one of which is friendlier to plain HTTP.

## Comparison with MCP streaming

The MCP surface uses the Streamable HTTP transport with `notifications/progress` for long `tools/call` operations (see `12-mcp-server.md`). MCP and SSE are deliberately separate:

- SSE is for **human-facing** clients: the CLI tail commands, browser dev tools, and other engine UIs.
- MCP Streamable HTTP is for **agent-facing** clients: AI agents that already speak MCP and want progress notifications interleaved with a final tool result.

Both surfaces stream the same underlying Execution events, but they wear different envelopes because their clients have different parsers. There is no plan to unify them into one transport.

## What the streaming surface does **not** do

- No bidirectional protocol on `/v1/conversations/:id/stream`. A turn is submitted with `POST /v1/conversations/:id/turns`, never inside the SSE channel.
- No binary frames. Everything is JSON-on-SSE-data.
- No client-side fan-in across multiple subjects. A client that wants to watch two Executions opens two streams.
- No SSE extensions beyond the standard `event` / `id` / `data` / `retry` framing. Resume is `Last-Event-ID`, full stop.
