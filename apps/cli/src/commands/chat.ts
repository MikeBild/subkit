// `subkit chat` — interactive REPL for the conversational authoring
// surface. Wires the Ink chat UI to the engine's POST /v1/conversations
// + GET /v1/conversations/:id/stream endpoints.
//
// Flow:
//   1. Resolve client args (engine URL, api key, tenant).
//   2. Either create a fresh conversation (POST /v1/conversations) or
//      resume an existing one via --resume <id>.
//   3. Open the SSE stream (GET /v1/conversations/:id/stream) and feed
//      its frames into the Ink app via an async iterable.
//   4. On approval frames, the Ink app surfaces the prompt; once the
//      user picks Y/N we POST the corresponding decision endpoint.
//   5. On Ctrl-C, POST /v1/conversations/:id/cancel and exit cleanly.
//   6. On `completed` frame, print a one-line summary and exit 0.
//
// The Ink layer is dynamically imported so non-chat invocations don't
// pay for it.

import { readSse } from "@cli-core/index.ts";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { formatError } from "../utils/errors.ts";

interface TurnEventLike {
  type: string;
  [k: string]: unknown;
}

export const chatCommand = defineCommand({
  meta: { name: "chat", description: "Conversational authoring REPL" },
  args: {
    ...clientArgs,
    resume: { type: "string", description: "Resume an existing conversation by id" },
    connector: { type: "string", description: "Target connector slug or id for a new chat" },
    workflow: { type: "string", description: "Target workflow id for a new chat" },
    prompt: {
      type: "positional",
      required: false,
      description: "Optional initial prompt message",
    },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);

    const initialPrompt = typeof args.prompt === "string" ? args.prompt : undefined;
    const resumeId = typeof args.resume === "string" ? args.resume : undefined;
    const connector = typeof args.connector === "string" ? args.connector : undefined;
    const workflow = typeof args.workflow === "string" ? args.workflow : undefined;

    let conversationId: string;
    try {
      if (resumeId) {
        const detail = await client.getConversation(resumeId);
        conversationId = detail.conversation.id;
      } else {
        const body: {
          initial_message?: string;
          connector_id?: string;
          workflow_id?: string;
        } = {};
        if (initialPrompt) body.initial_message = initialPrompt;
        if (connector) body.connector_id = connector;
        if (workflow) body.workflow_id = workflow;
        const created = await client.createConversation(body);
        conversationId = created.conversation.id;
      }
    } catch (err) {
      process.stderr.write(`subkit chat: ${formatError(err)}\n`);
      process.exit(1);
    }

    // SSE stream → AsyncIterable<TurnEvent> bridge. We push raw frames
    // into a queue; the Ink app pulls them via async iteration.
    const controller = new AbortController();
    const queue = createFrameQueue();

    let response: Response;
    try {
      response = await client.streamConversation(conversationId);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        process.stderr.write(
          `subkit chat: failed to open stream (HTTP ${response.status}) ${text}\n`,
        );
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`subkit chat: ${formatError(err)}\n`);
      process.exit(1);
    }

    void readSse(
      response,
      (frame) => {
        let parsed: TurnEventLike;
        try {
          parsed = JSON.parse(frame.data) as TurnEventLike;
        } catch {
          return;
        }
        if (typeof parsed.type !== "string") parsed.type = frame.event;
        queue.push(parsed);
        if (parsed.type === "completed") queue.close();
      },
      controller.signal,
    )
      .catch(() => {
        queue.close();
      })
      .finally(() => {
        queue.close();
      });

    // Cancel on Ctrl-C: POST cancel + abort the SSE reader so the Ink
    // loop unblocks.
    let cancelling = false;
    const onSigint = async () => {
      if (cancelling) return;
      cancelling = true;
      controller.abort();
      try {
        await client.cancelConversation(conversationId);
      } catch (err) {
        process.stderr.write(`subkit chat: cancel failed: ${formatError(err)}\n`);
      }
      queue.close();
    };
    process.on("SIGINT", () => {
      void onSigint();
    });

    const React = await import("react");
    const { render } = await import("ink");
    const { App } = await import("../chat-ui/app.tsx");
    const { initialState } = await import("../chat-ui/hooks.ts");

    const initial = initialState(conversationId, null);
    if (initialPrompt) {
      initial.messages.push({ role: "user", content: initialPrompt });
    }

    const handleApproval = async (decision: {
      approvalId: string;
      decision: "approved" | "rejected";
    }) => {
      try {
        await client.decideApproval(conversationId, decision.approvalId, decision.decision);
        // Re-open the stream to receive subsequent events. The engine
        // route replays from persisted state, so this is safe and idempotent.
        const next = await client.streamConversation(conversationId);
        if (next.ok) {
          void readSse(
            next,
            (frame) => {
              let parsed: TurnEventLike;
              try {
                parsed = JSON.parse(frame.data) as TurnEventLike;
              } catch {
                return;
              }
              if (typeof parsed.type !== "string") parsed.type = frame.event;
              queue.push(parsed);
              if (parsed.type === "completed") queue.close();
            },
            controller.signal,
          ).catch(() => {});
        }
      } catch (err) {
        process.stderr.write(`subkit chat: approval failed: ${formatError(err)}\n`);
      }
    };

    const instance = render(
      React.createElement(App, {
        initial,
        stream: queue.iterable as AsyncIterable<never>,
        onApproval: handleApproval,
      }),
    );

    // Stop the Ink instance when the queue is exhausted (i.e. the
    // stream closed, usually after `completed`).
    void queue.donePromise.then(() => {
      // Let React flush the final frame before unmounting.
      setTimeout(() => instance.unmount(), 0);
    });

    await instance.waitUntilExit();
    process.stdout.write(`subkit chat: conversation ${conversationId} ended.\n`);
  },
});

// --- Local helpers ---

interface FrameQueue {
  push(frame: TurnEventLike): void;
  close(): void;
  readonly iterable: AsyncIterable<TurnEventLike>;
  readonly donePromise: Promise<void>;
}

/**
 * Single-producer, single-consumer queue exposing an AsyncIterable.
 * Buffers frames pushed before iteration starts and resolves the
 * iterator on `close()`.
 */
function createFrameQueue(): FrameQueue {
  const buffer: TurnEventLike[] = [];
  const waiters: Array<(v: IteratorResult<TurnEventLike>) => void> = [];
  let closed = false;
  let resolveDone: () => void;
  const donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });

  const iterable: AsyncIterable<TurnEventLike> = {
    [Symbol.asyncIterator](): AsyncIterator<TurnEventLike> {
      return {
        next() {
          if (buffer.length > 0) {
            const value = buffer.shift() as TurnEventLike;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as TurnEventLike, done: true });
          }
          return new Promise<IteratorResult<TurnEventLike>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };

  return {
    push(frame: TurnEventLike) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: frame, done: false });
      } else {
        buffer.push(frame);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        w?.({ value: undefined as unknown as TurnEventLike, done: true });
      }
      resolveDone();
    },
    iterable,
    donePromise,
  };
}
