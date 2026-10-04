import { describe, expect, test } from "bun:test";
import {
  describeTransformGateBlock,
  detectHandRolledCodec,
  evaluateTransformAuthoringGate,
} from "../transform-authoring-gate.ts";

const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("evaluateTransformAuthoringGate — rejects hand-rolled base64 encoder", () => {
  test("blocks a transform that embeds the standard base64 alphabet in a var declaration", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
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

describe("evaluateTransformAuthoringGate — accepts sk.base64UrlEncode form (correct pattern)", () => {
  test("does NOT block a transform that calls sk.base64UrlEncode", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
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

describe("detectHandRolledCodec — hand-rolled encoder cases", () => {
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
    const fixture = `const asset='SGVsbG8sIHdvcmxkISBUaGlzIGlzIGEgZml4dHVyZSBwYXlsb2FkLg==';`;
    expect(detectHandRolledCodec(fixture)).toEqual({ found: false, kind: null });
  });
});
