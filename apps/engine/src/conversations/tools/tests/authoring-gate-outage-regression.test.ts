// Authoring gate regression tests for the Gmail send outage.
//
// The outage root cause: the LLM authored a transform step whose JS
// expression contained `var B="<base64-alphabet>"`. The redactor corrupted
// the alphabet literal; the hand-rolled encoder then emitted "undefined"
// 43,923x. The authoring gate now rejects any transform that embeds
// a hand-rolled codec alphabet and steers the author to `sk.base64UrlEncode`
// (and the rest of the sk.base64* / sk.hex* family).
//
// These tests pin the specific variants requested in the regression spec:
// 1. Rejects a hand-rolled base64 encoder (both standard and url-safe forms).
// 2. Accepts the `sk.base64UrlEncode` form — no block, gate passes.
// 3. Accepts transforms that use other sk.* encoding helpers.
// 4. Rejects a hand-rolled hex table, steers to sk.hexEncode.

import { describe, expect, test } from "bun:test";
import {
  describeTransformGateBlock,
  detectHandRolledCodec,
  evaluateTransformAuthoringGate,
} from "../transform-authoring-gate.ts";

const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// ---------------------------------------------------------------------------
// 1. Gate REJECTS hand-rolled base64 encoder.
// ---------------------------------------------------------------------------

describe("evaluateTransformAuthoringGate — rejects hand-rolled base64 encoder (outage regression)", () => {
  test("blocks a transform that embeds the standard base64 alphabet in a var declaration", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            // The exact shape the LLM authored before the outage fix.
            expression: `var B="${B64_STD}";let o="";for(let i=0;i<input.input.s.length;i+=3){const b0=input.input.s.charCodeAt(i);o+=B[b0>>2];}return o;`,
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    const block = result.blocks[0];
    expect(block?.reason).toBe("hand_rolled_codec_alphabet");
    expect(block?.transform_step_id).toBe("encode");
    expect(block?.codec_kind).toBe("base64");
  });

  test("blocks a transform that embeds the url-safe base64 alphabet", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "url_encode",
            kind: "transform",
            expression: `const CHARS="${B64_URL}";return CHARS[0];`,
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("hand_rolled_codec_alphabet");
    expect(result.blocks[0]?.codec_kind).toBe("base64");
  });

  test("the block's steer message names sk.base64UrlEncode as the replacement", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            expression: `const B="${B64_STD}";return B;`,
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    const msg = describeTransformGateBlock(result.blocks[0]!);
    expect(msg).toContain("sk.base64UrlEncode");
    expect(msg).toContain("sk.base64Encode");
  });
});

// ---------------------------------------------------------------------------
// 2. Gate ACCEPTS the sk.base64UrlEncode form.
// This is the correct authoring pattern: use the deterministic sandbox
// primitive instead of hand-rolling an encoder from an alphabet literal.
// ---------------------------------------------------------------------------

describe("evaluateTransformAuthoringGate — accepts sk.base64UrlEncode form (correct pattern)", () => {
  test("does NOT block a transform that calls sk.base64UrlEncode", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            // Correct pattern: sk.base64UrlEncode is a deterministic sandbox
            // primitive; no alphabet literal involved.
            expression: "return sk.base64UrlEncode(input.input.payload);",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(0);
  });

  test("does NOT block a transform that calls sk.base64UrlEncodeUtf8", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            expression: "return sk.base64UrlEncodeUtf8(input.input.body);",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(0);
  });

  test("does NOT block a Gmail-raw-style transform that calls sk.base64UrlEncode", () => {
    // The corrected authoring pattern for the Gmail send workflow.
    // Before the outage, the LLM hand-rolled this with an alphabet literal.
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "build_mime", kind: "request" },
          {
            id: "encode_for_gmail",
            kind: "transform",
            expression: [
              "const mime = input.scope.build_mime.data.body;",
              "return { raw: sk.base64UrlEncode(mime) };",
            ].join("\n"),
          },
        ],
      },
      {
        ok: true,
        summary: "ok",
        step_traces: [
          {
            step_id: "build_mime",
            kind: "request",
            status: "succeeded",
            output_preview: { body: "To: user@example.com\r\n\r\nHello" },
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Gate ACCEPTS other sk.* encoding helpers.
// ---------------------------------------------------------------------------

describe("evaluateTransformAuthoringGate — accepts sk.base64Encode and sk.hex*", () => {
  test("does NOT block a transform that calls sk.base64Encode", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            expression: "return sk.base64Encode(input.input.s);",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("does NOT block a transform that calls sk.base64EncodeUtf8", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            expression: "return sk.base64EncodeUtf8(input.input.s);",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("does NOT block a transform that calls sk.hexEncode", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "hex",
            kind: "transform",
            expression: "return sk.hexEncode(input.input.s);",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Gate REJECTS hand-rolled hex table, steers to sk.hexEncode.
// ---------------------------------------------------------------------------

describe("evaluateTransformAuthoringGate — rejects hand-rolled hex table", () => {
  test("blocks a transform that embeds a hex encode table literal", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "hex",
            kind: "transform",
            expression: `const HEX="0123456789abcdef";let o="";for(const b of input.input.bytes){o+=HEX[(b>>4)&0xf]+HEX[b&0xf];}return o;`,
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("hand_rolled_codec_alphabet");
    expect(result.blocks[0]?.codec_kind).toBe("hex_table");
    const msg = describeTransformGateBlock(result.blocks[0]!);
    expect(msg).toContain("sk.hexEncode");
  });
});

// ---------------------------------------------------------------------------
// detectHandRolledCodec — unit tests for the pure detector.
// ---------------------------------------------------------------------------

describe("detectHandRolledCodec — specific outage-regression cases", () => {
  test("detects the standard base64 alphabet inside a const declaration", () => {
    expect(detectHandRolledCodec(`const B="${B64_STD}";`)).toEqual({
      found: true,
      kind: "base64",
    });
  });

  test("detects the url-safe base64 alphabet inside a var declaration", () => {
    expect(detectHandRolledCodec(`var CHARS="${B64_URL}";`)).toEqual({
      found: true,
      kind: "base64",
    });
  });

  test("does NOT detect sk.base64UrlEncode (no alphabet literal)", () => {
    expect(detectHandRolledCodec("return sk.base64UrlEncode(input.input.s);")).toEqual({
      found: false,
      kind: null,
    });
  });

  test("does NOT detect a long base64 DATA literal (not the ordered alphabet)", () => {
    // The fixture string is a real base64-encoded payload — high entropy,
    // long, but not the sequential A-Z a-z 0-9 alphabet ordering. Must pass.
    const fixture = `const asset='SGVsbG8sIHdvcmxkISBUaGlzIGlzIGEgZml4dHVyZSBwYXlsb2FkLg==';`;
    expect(detectHandRolledCodec(fixture)).toEqual({ found: false, kind: null });
  });
});
