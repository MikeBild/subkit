// `trackStreamLifetime` — the bound on a session's in-flight retain.
//
// Regression this file exists for: the retain used to be released only when the
// wrapped body ended, errored, or was cancelled, plus a ONE-SHOT 30 s grace that
// was disarmed permanently on the first `pull`. A standalone GET notification
// channel pulls once and then waits. When its client vanished without a clean
// close, `read()` never settled and `cancel` never came — so the retain pinned
// `inFlight` at 1 forever. Production reached 120 such leases against 6 live TCP
// connections; every `initialize` then 503'd for hours.
//
// The window is a real `setTimeout` (the `utils/clock.ts` seam only fakes
// `now()`), so these tests inject a few milliseconds via the `silentMs`
// parameter instead of waiting out the production default.

import { describe, expect, test } from "bun:test";
import { trackStreamLifetime } from "./streamable-http.ts";

const SILENT_MS = 10;
// Comfortably past the window, but short enough to keep the suite quick.
const PAST_WINDOW_MS = 60;

interface RetainSpy {
  retain: {
    release: () => void;
    reacquire: () => void;
    onForceReleased: () => void;
  };
  /** Net retains held: starts at 1, mirrors the lease's `inFlight`. */
  held: () => number;
  forceReleases: () => number;
}

function retainSpy(): RetainSpy {
  let held = 1;
  let forceReleases = 0;
  return {
    retain: {
      release: () => {
        held -= 1;
      },
      reacquire: () => {
        held += 1;
      },
      onForceReleased: () => {
        forceReleases += 1;
      },
    },
    held: () => held,
    forceReleases: () => forceReleases,
  };
}

/** A body that emits `chunks` and then stalls forever — the shape of an SSE
 *  notification channel whose client has gone away without closing. */
function stallingBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks.length) {
        controller.enqueue(encoder.encode(chunks[sent] as string));
        sent += 1;
        return;
      }
      // Never resolves: no more data, no close, no error.
      return new Promise<void>(() => {});
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>, reads: number): Promise<void> {
  const reader = stream.getReader();
  for (let i = 0; i < reads; i++) {
    await reader.read();
  }
  // Deliberately NOT cancelled or released — the abandoned-client shape.
}

describe("trackStreamLifetime · silence window", () => {
  test("a stream that is pulled and then stalls hands its retain back", async () => {
    const spy = retainSpy();
    const wrapped = trackStreamLifetime(stallingBody(["event: one\n\n"]), spy.retain, SILENT_MS);

    // One chunk crosses the wire, then the stream goes silent forever.
    await drain(wrapped, 1);
    expect(spy.held()).toBe(1);

    await Bun.sleep(PAST_WINDOW_MS);

    // THE REGRESSION: this used to stay at 1 for the life of the process.
    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(1);
  });

  test("a body nobody ever pulls hands its retain back too", async () => {
    const spy = retainSpy();
    trackStreamLifetime(stallingBody([]), spy.retain, SILENT_MS);

    await Bun.sleep(PAST_WINDOW_MS);

    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(1);
  });

  test("a chunk arriving after a force-release reclaims the retain exactly once", async () => {
    const spy = retainSpy();
    const encoder = new TextEncoder();
    let release: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!release) {
          // First pull: block until the test lets a chunk through, so the
          // silence window fires while the stream is genuinely quiet.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        controller.enqueue(encoder.encode("event: late\n\n"));
      },
    });
    const wrapped = trackStreamLifetime(body, spy.retain, SILENT_MS);
    const reader = wrapped.getReader();
    const pending = reader.read();

    await Bun.sleep(PAST_WINDOW_MS);
    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(1);

    // The stream was alive after all — it takes the retain back.
    release?.();
    await pending;
    expect(spy.held()).toBe(1);

    // And is bounded again by the same window.
    await Bun.sleep(PAST_WINDOW_MS);
    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(2);
  });

  test("a stream that keeps delivering chunks keeps its retain", async () => {
    const spy = retainSpy();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Slower than nothing, faster than the window — a live channel.
        await Bun.sleep(SILENT_MS / 2);
        controller.enqueue(encoder.encode("event: tick\n\n"));
      },
    });
    const wrapped = trackStreamLifetime(body, spy.retain, SILENT_MS);
    const reader = wrapped.getReader();

    for (let i = 0; i < 8; i++) {
      await reader.read();
      expect(spy.held()).toBe(1);
    }
    expect(spy.forceReleases()).toBe(0);
  });

  test("a normal end releases the retain once, and the silence window cannot double-release", async () => {
    const spy = retainSpy();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: only\n\n"));
        controller.close();
      },
    });
    const wrapped = trackStreamLifetime(body, spy.retain, SILENT_MS);
    const reader = wrapped.getReader();
    await reader.read();
    await reader.read(); // done

    expect(spy.held()).toBe(0);

    await Bun.sleep(PAST_WINDOW_MS);

    // Still exactly one release — the window was disarmed by `finish`.
    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(0);
  });

  test("cancel releases the retain once", async () => {
    const spy = retainSpy();
    const wrapped = trackStreamLifetime(stallingBody(["event: one\n\n"]), spy.retain, SILENT_MS);
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel("client went away");

    expect(spy.held()).toBe(0);

    await Bun.sleep(PAST_WINDOW_MS);
    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(0);
  });
});
