import { afterEach, describe, expect, test } from "bun:test";
import { installChatConversationCapture } from "./cockpit-chat-sse.mjs";

const originalWindow = globalThis.window;
const originalLocation = globalThis.location;

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.location = originalLocation;
});

describe("Cockpit conversation SSE ownership capture", () => {
  test("captures a CRLF frame split across chunks before returning the original response", async () => {
    const captured: string[] = [];
    let persisted = false;
    const response = {
      body: {},
      headers: new Headers({ "content-type": "text/event-stream" }),
      clone: () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: conversation_sta"));
            controller.enqueue(
              new TextEncoder().encode(
                'rted\r\ndata: {"conversation":{"id":"f29e4c9b-6cec-4afc-83ef-634cc3fd065d"}}\r',
              ),
            );
            controller.enqueue(new TextEncoder().encode("\n\r\n"));
            controller.close();
          },
        }),
      }),
    };
    globalThis.location = {
      href: "http://127.0.0.1:3000/cockpit/chat/new",
      origin: "http://127.0.0.1:3000",
    } as Location;
    globalThis.window = {
      fetch: async () => response,
      __subkitCaptureOwnedConversation: async ({ id }: { id: string }) => {
        await Promise.resolve();
        persisted = true;
        captured.push(id);
      },
      __subkitConversationCaptureFailure: async (reason: string) => {
        throw new Error(reason);
      },
    } as unknown as Window & typeof globalThis;
    installChatConversationCapture({ timeoutMs: 100 });

    let responseReleased = false;
    const returned = await window
      .fetch("/v1/conversations", {
        method: "POST",
        headers: { accept: "text/event-stream" },
      })
      .then((value) => {
        responseReleased = true;
        expect(persisted).toBe(true);
        expect(captured).toEqual(["f29e4c9b-6cec-4afc-83ef-634cc3fd065d"]);
        return value;
      });
    expect(returned).toBe(response);
    expect(responseReleased).toBe(true);
  });

  test("bounds a stalled capture, cancels its reader, and returns the original response", async () => {
    let cancelled = false;
    const failures: string[] = [];
    const response = {
      body: {},
      headers: new Headers({ "content-type": "text/event-stream" }),
      clone: () => ({
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: async () => {
              cancelled = true;
            },
          }),
        },
      }),
    };
    globalThis.location = {
      href: "http://127.0.0.1:3000/cockpit/chat/new",
      origin: "http://127.0.0.1:3000",
    } as Location;
    globalThis.window = {
      fetch: async () => response,
      __subkitCaptureOwnedConversation: async () => {},
      __subkitConversationCaptureFailure: async (reason: string) => failures.push(reason),
    } as unknown as Window & typeof globalThis;
    installChatConversationCapture({ timeoutMs: 10 });

    const returned = await window.fetch("/v1/conversations", {
      method: "POST",
      headers: { accept: "text/event-stream" },
    });
    expect(returned).toBe(response);
    expect(cancelled).toBe(true);
    expect(failures).toEqual(["Timed out before receiving conversation_started"]);
  });

  test("bounds reader cancellation when the stream does not settle", async () => {
    const response = {
      body: {},
      headers: new Headers({ "content-type": "text/event-stream" }),
      clone: () => ({
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: () => new Promise(() => {}),
          }),
        },
      }),
    };
    globalThis.location = {
      href: "http://127.0.0.1:3000/cockpit/chat/new",
      origin: "http://127.0.0.1:3000",
    } as Location;
    globalThis.window = {
      fetch: async () => response,
      __subkitCaptureOwnedConversation: async () => {},
      __subkitConversationCaptureFailure: async () => {},
    } as unknown as Window & typeof globalThis;
    installChatConversationCapture({ timeoutMs: 5 });

    const start = performance.now();
    const returned = await window.fetch("/v1/conversations", {
      method: "POST",
      headers: { accept: "text/event-stream" },
    });
    expect(returned).toBe(response);
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("ignores JSON conversation creates and matching paths on another origin", async () => {
    let captures = 0;
    const response = { body: {}, headers: new Headers({ "content-type": "application/json" }) };
    globalThis.location = {
      href: "http://127.0.0.1:3000/cockpit/chat/new",
      origin: "http://127.0.0.1:3000",
    } as Location;
    globalThis.window = {
      fetch: async () => response,
      __subkitCaptureOwnedConversation: async () => {
        captures += 1;
      },
      __subkitConversationCaptureFailure: async () => {
        captures += 1;
      },
    } as unknown as Window & typeof globalThis;
    installChatConversationCapture({ timeoutMs: 10 });

    await window.fetch("/v1/conversations", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    await window.fetch("https://other.example/v1/conversations", {
      method: "POST",
      headers: { accept: "text/event-stream" },
    });
    expect(captures).toBe(0);
  });

  test("rejects an unexpectedly large SSE response within the configured bound", async () => {
    const failures: string[] = [];
    const response = {
      body: {},
      headers: new Headers({ "content-type": "text/event-stream" }),
      clone: () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16));
            controller.close();
          },
        }),
      }),
    };
    globalThis.location = {
      href: "http://127.0.0.1:3000/cockpit/chat/new",
      origin: "http://127.0.0.1:3000",
    } as Location;
    globalThis.window = {
      fetch: async () => response,
      __subkitCaptureOwnedConversation: async () => {},
      __subkitConversationCaptureFailure: async (reason: string) => failures.push(reason),
    } as unknown as Window & typeof globalThis;
    installChatConversationCapture({ timeoutMs: 100, maxBytes: 8 });

    const returned = await window.fetch("/v1/conversations", {
      method: "POST",
      headers: { accept: "text/event-stream" },
    });
    expect(returned).toBe(response);
    expect(failures).toEqual(["Error: Conversation stream exceeded capture limit"]);
  });
});
