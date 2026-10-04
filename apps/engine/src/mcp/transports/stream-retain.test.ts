import { describe, expect, test } from "bun:test";
import { isKeepaliveOnly, trackStreamLifetime } from "./session-lease.ts";

const SILENT_MS = 10;
const PAST_WINDOW_MS = 60;

interface RetainSpy {
  retain: {
    release: () => void;
    reacquire: () => void;
    onForceReleased: () => void;
  };
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
      return new Promise<void>(() => {});
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>, reads: number): Promise<void> {
  const reader = stream.getReader();
  for (let i = 0; i < reads; i++) {
    await reader.read();
  }
}

describe("isKeepaliveOnly", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  test("SSE comment frames carry no payload", () => {
    expect(isKeepaliveOnly(enc(": keepalive\n\n"))).toBe(true);
    expect(isKeepaliveOnly(enc(": keepalive\n\n: keepalive\n\n"))).toBe(true);
    expect(isKeepaliveOnly(enc(""))).toBe(true);
    expect(isKeepaliveOnly(enc("\n\n"))).toBe(true);
  });

  test("anything a client asked for is payload", () => {
    expect(isKeepaliveOnly(enc('event: message\ndata: {"x":1}\n\n'))).toBe(false);
    expect(isKeepaliveOnly(enc('data: {"jsonrpc":"2.0"}\n\n'))).toBe(false);
    expect(isKeepaliveOnly(enc(': keepalive\n\ndata: {"x":1}\n\n'))).toBe(false);
  });

  test("a large chunk is payload without decoding it", () => {
    expect(isKeepaliveOnly(enc(`: ${"x".repeat(600)}\n\n`))).toBe(false);
  });
});

describe("trackStreamLifetime · silence window", () => {
  test("a stream that is pulled and then stalls hands its retain back", async () => {
    const spy = retainSpy();
    const wrapped = trackStreamLifetime(stallingBody(["event: one\n\n"]), spy.retain, SILENT_MS);

    await drain(wrapped, 1);
    expect(spy.held()).toBe(1);

    await Bun.sleep(PAST_WINDOW_MS);

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

    release?.();
    await pending;
    expect(spy.held()).toBe(1);

    await Bun.sleep(PAST_WINDOW_MS);
    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(2);
  });

  test("a stream that keeps delivering chunks keeps its retain", async () => {
    const spy = retainSpy();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
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

  test("a stream carrying only SDK keepalives is NOT alive — the retain still comes back", async () => {
    const spy = retainSpy();
    const encoder = new TextEncoder();
    const WINDOW_MS = 60;
    const FRAME_MS = 10;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(FRAME_MS);
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      },
    });
    const wrapped = trackStreamLifetime(body, spy.retain, WINDOW_MS);
    const reader = wrapped.getReader();

    for (let i = 0; i < 20; i++) await reader.read();

    expect(spy.held()).toBe(0);
    expect(spy.forceReleases()).toBe(1);
  });

  test("a payload frame among keepalives does count as liveness", async () => {
    const spy = retainSpy();
    const encoder = new TextEncoder();
    const WINDOW_MS = 80;
    const FRAME_MS = 10;
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(FRAME_MS);
        n += 1;
        controller.enqueue(
          encoder.encode(n % 3 === 0 ? 'event: message\ndata: {"x":1}\n\n' : ": keepalive\n\n"),
        );
      },
    });
    const wrapped = trackStreamLifetime(body, spy.retain, WINDOW_MS);
    const reader = wrapped.getReader();

    for (let i = 0; i < 12; i++) await reader.read();

    expect(spy.held()).toBe(1);
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
    await reader.read();

    expect(spy.held()).toBe(0);

    await Bun.sleep(PAST_WINDOW_MS);

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
