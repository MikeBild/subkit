import { describe, expect, test } from "bun:test";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describeTurnFailure, timeoutPhaseOf } from "../turn-failure.ts";

function silentModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "silent",
    provider: "mock",
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          if (abortSignal?.aborted) {
            controller.error(abortSignal.reason);
            return;
          }
          abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason), {
            once: true,
          });
        },
      }),
    }),
  });
}

async function drain(result: { textStream: AsyncIterable<string> }): Promise<void> {
  for await (const _chunk of result.textStream) {
  }
}

type AbortEvent = { reason?: unknown; steps: unknown[] };

describe("streamText typed timeouts — the contract the converse loop builds on", () => {
  test("firstChunkMs aborts a provider that never answers; onAbort carries the labelled reason and finishReason rejects", async () => {
    const aborts: AbortEvent[] = [];
    const errors: unknown[] = [];
    const result = streamText({
      model: silentModel(),
      prompt: "hi",
      timeout: { firstChunkMs: 20 },
      onAbort: (event) => {
        aborts.push(event as AbortEvent);
      },
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    await drain(result);
    expect(errors).toEqual([]);
    expect(aborts).toHaveLength(1);
    const reason = aborts[0]?.reason;
    expect(reason).toBeInstanceOf(DOMException);
    expect(timeoutPhaseOf(reason)).toBe("first_chunk");
    expect(describeTurnFailure(reason)).toMatchObject({
      code: "llm_timeout",
      message: "Timed out after 1 s",
      timeout: { phase: "first_chunk", timeout_ms: 20 },
    });
    await expect(result.finishReason).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("totalMs aborts with the platform's own timeout reason, which is the total phase", async () => {
    const aborts: AbortEvent[] = [];
    const result = streamText({
      model: silentModel(),
      prompt: "hi",
      timeout: { totalMs: 20 },
      onAbort: (event) => {
        aborts.push(event as AbortEvent);
      },
    });
    await drain(result);
    expect(aborts).toHaveLength(1);
    expect(timeoutPhaseOf(aborts[0]?.reason)).toBe("total");
  });

  test("a caller's own abort is no timeout: the stream throws the caller's reason and onAbort stays silent", async () => {
    const aborts: AbortEvent[] = [];
    const errors: unknown[] = [];
    const ctrl = new AbortController();
    const result = streamText({
      model: silentModel(),
      prompt: "hi",
      abortSignal: ctrl.signal,
      timeout: { firstChunkMs: 5_000 },
      onAbort: (event) => {
        aborts.push(event as AbortEvent);
      },
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    const draining = drain(result).catch((err: unknown) => err);
    ctrl.abort("conversation_cancelled");
    const thrown = await draining;
    expect(aborts).toEqual([]);
    expect(errors).toEqual([]);
    expect(thrown).toBe("conversation_cancelled");
    expect(timeoutPhaseOf(thrown)).toBeNull();
  });
});
