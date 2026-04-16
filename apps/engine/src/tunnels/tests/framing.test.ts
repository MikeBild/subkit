import { describe, expect, test } from "bun:test";
import { decodeFrame, encodeFrame, type TunnelFrame } from "../framing.ts";

describe("tunnel framing", () => {
  test("round-trips every variant of TunnelFrame", () => {
    const samples: TunnelFrame[] = [
      {
        type: "register",
        agent_version: "1.2.3",
        targets: [{ name: "internal", local_base_url: "http://localhost:8080/" }],
      },
      { type: "register_ack", tunnel_id: "abc" },
      {
        type: "request",
        request_id: "r1",
        target: "internal",
        method: "GET",
        path: "/v1/x?q=1",
        headers: { "x-foo": "bar" },
        body: null,
      },
      {
        type: "response",
        request_id: "r1",
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
      { type: "ping", ts: 1000 },
      { type: "pong", ts: 1000 },
      { type: "unregister" },
      { type: "error", code: "bad_thing", message: "explode" },
    ];
    for (const sample of samples) {
      const encoded = encodeFrame(sample);
      const decoded = decodeFrame(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.frame).toEqual(sample);
      }
    }
    // Malformed payloads return an error instead of throwing.
    const bad = decodeFrame("{not-json");
    expect(bad.ok).toBe(false);
    const bad2 = decodeFrame(JSON.stringify({ type: "not_a_type" }));
    expect(bad2.ok).toBe(false);
  });
});
