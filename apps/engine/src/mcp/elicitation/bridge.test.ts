// ElicitationBridge unit tests.
//
// The bridge is the single seam between conversation tools and the MCP
// SDK's `server.elicitInput()`. These tests pin: capability detection
// from `getClientCapabilities()`, the `relatedRequestId` forwarding that
// routes the server→client request onto the in-flight `tools/call` SSE
// stream, `ElicitationUnsupportedError` when a capability is absent, the
// accept/decline/cancel result parsing, and the `mode: "form"` vs
// `mode: "url"` wire shape.
//
// No DB, no network — the MCP `Server` is a hand-rolled stub.

import { describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  ElicitationUnsupportedError,
  type ElicitRequestedSchema,
} from "../../conversations/elicitation-bridge.ts";
import { createElicitationBridge, ElicitationBridge } from "./bridge.ts";

type ElicitInputCall = { params: unknown; options: unknown };

/** A minimal MCP `Server` stub: records `elicitInput` calls and returns
 *  a canned result; advertises (or withholds) the elicitation cap. */
function makeServerStub(opts: {
  elicitationCap?: Record<string, unknown> | null;
  elicitResult?: { action: string; content?: Record<string, unknown> };
}): { server: Server; calls: ElicitInputCall[] } {
  const calls: ElicitInputCall[] = [];
  const server = {
    getClientCapabilities(): { elicitation?: unknown } | undefined {
      if (opts.elicitationCap === undefined) return {};
      if (opts.elicitationCap === null) return {};
      return { elicitation: opts.elicitationCap };
    },
    async elicitInput(params: unknown, options: unknown): Promise<unknown> {
      calls.push({ params, options });
      return opts.elicitResult ?? { action: "accept", content: {} };
    },
  } as unknown as Server;
  return { server, calls };
}

function makeExtra(
  requestId: string | number,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return { requestId } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

const FLAT_SCHEMA: ElicitRequestedSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
};

describe("ElicitationBridge — capability detection", () => {
  test("empty elicitation capability object → backwards-compatible form only", () => {
    const { server } = makeServerStub({ elicitationCap: {} });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    expect(bridge.capabilities).toEqual({ form: true, oob: false });
  });

  test("form-only elicitation capability → form true, url/oob false", () => {
    const { server } = makeServerStub({ elicitationCap: { form: {} } });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    expect(bridge.capabilities).toEqual({ form: true, oob: false });
  });

  test("url-only elicitation capability → form false, url/oob true", () => {
    const { server } = makeServerStub({ elicitationCap: { url: {} } });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    expect(bridge.capabilities).toEqual({ form: false, oob: true });
  });

  test("form+url elicitation capability → both modes true", () => {
    const { server } = makeServerStub({ elicitationCap: { form: {}, url: {} } });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    expect(bridge.capabilities).toEqual({ form: true, oob: true });
  });

  test("absent elicitation capability → form AND oob both false", () => {
    const { server } = makeServerStub({ elicitationCap: null });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    expect(bridge.capabilities).toEqual({ form: false, oob: false });
  });

  test("createElicitationBridge factory builds an equivalent bridge", () => {
    const { server } = makeServerStub({ elicitationCap: {} });
    const bridge = createElicitationBridge(server, makeExtra("req-1"));
    expect(bridge).toBeInstanceOf(ElicitationBridge);
    expect(bridge.capabilities.form).toBe(true);
  });
});

describe("ElicitationBridge.elicitForm", () => {
  test("sends mode:form, the message + requestedSchema, and forwards relatedRequestId", async () => {
    const { server, calls } = makeServerStub({
      elicitationCap: { form: {} },
      elicitResult: { action: "accept", content: { value: "hi" } },
    });
    const bridge = new ElicitationBridge(server, makeExtra("req-42"));
    const result = await bridge.elicitForm({
      message: "What is your name?",
      requestedSchema: FLAT_SCHEMA,
    });

    expect(calls).toHaveLength(1);
    const params = calls[0]!.params as Record<string, unknown>;
    expect(params.mode).toBe("form");
    expect(params.message).toBe("What is your name?");
    expect(params.requestedSchema).toEqual(FLAT_SCHEMA);
    // relatedRequestId is mandatory — it routes the server→client request
    // onto the same SSE stream as the in-flight tools/call. The bounded
    // timeout keeps an unfulfilled elicitation from hanging the tools/call.
    expect(calls[0]!.options).toEqual({ relatedRequestId: "req-42", timeout: 10_000 });
    expect(result).toEqual({ action: "accept", content: { value: "hi" } });
  });

  test("throws ElicitationUnsupportedError when the client did not advertise the capability", async () => {
    const { server, calls } = makeServerStub({ elicitationCap: null });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    let thrown: unknown;
    try {
      await bridge.elicitForm({ message: "x", requestedSchema: FLAT_SCHEMA });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ElicitationUnsupportedError);
    expect((thrown as ElicitationUnsupportedError).capability).toBe("form");
    // The SDK was never called — the bridge short-circuits on the cap.
    expect(calls).toHaveLength(0);
  });

  test("decline result parses with no content", async () => {
    const { server } = makeServerStub({
      elicitationCap: { form: {} },
      elicitResult: { action: "decline" },
    });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    const result = await bridge.elicitForm({ message: "x", requestedSchema: FLAT_SCHEMA });
    expect(result.action).toBe("decline");
    expect(result.content).toBeUndefined();
  });

  test("cancel result parses with no content", async () => {
    const { server } = makeServerStub({
      elicitationCap: { form: {} },
      elicitResult: { action: "cancel" },
    });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    const result = await bridge.elicitForm({ message: "x", requestedSchema: FLAT_SCHEMA });
    expect(result.action).toBe("cancel");
    expect(result.content).toBeUndefined();
  });
});

describe("ElicitationBridge.elicitOob", () => {
  test("sends mode:url on the wire (SDK contract) with the URL + elicitationId", async () => {
    const { server, calls } = makeServerStub({
      elicitationCap: { url: {} },
      elicitResult: { action: "accept" },
    });
    const bridge = new ElicitationBridge(server, makeExtra("req-7"));
    await bridge.elicitOob({
      message: "Authorize in your browser",
      url: "https://accounts.example.test/authorize?state=abc",
      elicitationId: "state-abc",
    });

    expect(calls).toHaveLength(1);
    const params = calls[0]!.params as Record<string, unknown>;
    expect(params.mode).toBe("url");
    expect(params.url).toBe("https://accounts.example.test/authorize?state=abc");
    expect(params.elicitationId).toBe("state-abc");
    expect(calls[0]!.options).toEqual({ relatedRequestId: "req-7", timeout: 10_000 });
  });

  test("throws ElicitationUnsupportedError for oob when capability absent", async () => {
    const { server } = makeServerStub({ elicitationCap: null });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    let thrown: unknown;
    try {
      await bridge.elicitOob({
        message: "x",
        url: "https://example.test/auth",
        elicitationId: "id-1",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ElicitationUnsupportedError);
    expect((thrown as ElicitationUnsupportedError).capability).toBe("oob");
  });

  test("throws ElicitationUnsupportedError for oob when client is form-only", async () => {
    const { server, calls } = makeServerStub({ elicitationCap: { form: {} } });
    const bridge = new ElicitationBridge(server, makeExtra("req-1"));
    let thrown: unknown;
    try {
      await bridge.elicitOob({
        message: "x",
        url: "https://example.test/auth",
        elicitationId: "id-1",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ElicitationUnsupportedError);
    expect((thrown as ElicitationUnsupportedError).capability).toBe("oob");
    expect(calls).toHaveLength(0);
  });
});
