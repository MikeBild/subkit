import { describe, expect, test } from "bun:test";
import { readSse } from "../sse.ts";

describe("readSse", () => {
  test("cancels a still-open stream when the consumer sees a terminal frame", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('event: message\ndata: {"type":"completed","status":"active"}\n\n'),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    const frames: string[] = [];
    await readSse(response, (frame) => {
      frames.push(frame.data);
      return false;
    });

    expect(frames).toHaveLength(1);
    expect(cancelled).toBe(true);
  });
});
