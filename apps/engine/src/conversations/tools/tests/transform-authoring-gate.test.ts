import { describe, expect, test } from "bun:test";
import type { WorkflowDraftStepPreview } from "../../types.ts";
import {
  describeTransformGateBlock,
  detectHandRolledCodec,
  evaluateTransformAuthoringGate,
} from "../transform-authoring-gate.ts";

const traceFor = (step_id: string, output_preview?: unknown): WorkflowDraftStepPreview => ({
  step_id,
  kind: "request",
  status: "succeeded",
  ...(output_preview !== undefined ? { output_preview } : {}),
});

describe("evaluateTransformAuthoringGate", () => {
  test("ok when there are no transform steps", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "a", kind: "request" },
          { id: "b", kind: "request" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  test("ok when the transform reads only $input (no $scope refs)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "shape",
            kind: "transform",
            expression: "{ id: input.input.x, n: $count(input.input.xs) }",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("blocks transform when no dry-run has been recorded yet", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "input.scope.fetch.data.items.{name: $.name}",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_dry_run_yet");
    expect(result.blocks[0]?.transform_step_id).toBe("format");
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });

  test("blocks transform when the referenced step has no recorded preview", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "other", kind: "request" },
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "input.scope.fetch.data.items",
          },
        ],
      },
      {
        ok: true,
        summary: "ok",
        step_traces: [traceFor("other", { something: 1 })],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_preview_for_referenced_step");
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });

  test("ok when the referenced step has a recorded output_preview", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "input.scope.fetch.data.items",
          },
        ],
      },
      {
        ok: true,
        summary: "ok",
        step_traces: [traceFor("fetch", { items: [{ id: 1, name: "a" }] })],
      },
    );
    expect(result.ok).toBe(true);
  });

  test("skips self-references (a transform reading its own output)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "format",
            kind: "transform",
            expression: "input.scope.format.data",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("does not flag references to step ids that aren't in the workflow", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "format",
            kind: "transform",
            expression: "input.scope.unknown.data",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("flags transforms patched onto an empty-output step", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          {
            id: "format",
            kind: "transform",
            expression: "input.scope.fetch.data",
          },
        ],
      },
      {
        ok: true,
        summary: "ok",
        step_traces: [{ ...traceFor("fetch"), output_preview: null }],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_preview_for_referenced_step");
  });

  test("exempts a transform that reads a branch then/else child step", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "decide",
            kind: "branch",
            when: "$x > 0",
            then_steps: ["fmt"],
            else_steps: ["fallback"],
          },
          { id: "fmt", kind: "transform", expression: "{ a: 1 }" },
          { id: "fallback", kind: "request" },
          {
            id: "consumer",
            kind: "transform",
            expression: "input.scope.fmt.data & input.scope.fallback.data",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("exempts a transform that reads a parallel branch child or the parallel step itself", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "par", kind: "parallel", branches: [["w1"], ["w2"]] },
          { id: "w1", kind: "request" },
          { id: "w2", kind: "request" },
          {
            id: "join",
            kind: "transform",
            expression: "{ a: input.scope.par.data, b: input.scope.w1.data }",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("still blocks a transform that reads a plain request sibling with no preview (regression)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "input.scope.fetch.data.items" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });

  test("exempts a transform whose referenced step failed with a 404 runtime error", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "input.scope.fetch.data.items" },
        ],
      },
      {
        ok: false,
        summary: "failed",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "failed",
            request_meta: { status: 404 },
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(0);
  });

  test("exempts a transform whose referenced step failed with a 410 Gone runtime error", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "input.scope.fetch.data.items" },
        ],
      },
      {
        ok: false,
        summary: "failed",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "error",
            request_meta: { status: 410 },
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(0);
  });

  test("still blocks a transform if the referenced step failed with a config-invalid error (not runtime)", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          { id: "fetch", kind: "request" },
          { id: "fmt", kind: "transform", expression: "input.scope.fetch.data.items" },
        ],
      },
      {
        ok: false,
        summary: "failed",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "error",
            error_code: "unresolved_identifier",
          },
        ],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.referenced_step_id).toBe("fetch");
  });
});

describe("detectHandRolledCodec", () => {
  const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  test("flags a standard base64 alphabet literal", () => {
    expect(detectHandRolledCodec(`const A="${B64_STD}";`)).toEqual({
      found: true,
      kind: "base64",
    });
  });

  test("flags a url-safe base64 alphabet literal", () => {
    expect(detectHandRolledCodec(`var b = '${B64_URL}';`)).toEqual({
      found: true,
      kind: "base64",
    });
  });

  test("flags a base32 alphabet literal", () => {
    expect(detectHandRolledCodec(`const a="${B32}";`)).toEqual({
      found: true,
      kind: "base32",
    });
  });

  test("flags a hex encode table literal", () => {
    expect(detectHandRolledCodec(`const HEX="0123456789abcdef";`)).toEqual({
      found: true,
      kind: "hex_table",
    });
  });

  test("flags a reverse-lookup table keyed by single chars to small ints", () => {
    const table = "const rev={A:0,B:1,C:2,D:3,E:4,F:5,G:6,H:7,I:8};return rev[input.input.c];";
    expect(detectHandRolledCodec(table)).toEqual({ found: true, kind: "reverse_lookup" });
  });

  test("does NOT flag a transform that uses sk.base64Encode", () => {
    expect(detectHandRolledCodec("return sk.base64Encode(input.input.s);")).toEqual({
      found: false,
      kind: null,
    });
  });

  test("does NOT flag a long base64 DATA literal (not the ordered alphabet)", () => {
    const data = "const asset='SGVsbG8sIHdvcmxkISBUaGlzIGlzIGEgZml4dHVyZSBwYXlsb2FkLg==aGVsbG8';";
    expect(detectHandRolledCodec(data)).toEqual({ found: false, kind: null });
  });

  test("does NOT flag an ordinary small object literal", () => {
    expect(detectHandRolledCodec("const m={a:1,b:2,c:3};return m;")).toEqual({
      found: false,
      kind: null,
    });
  });

  test("flags a base64 alphabet split across concatenated string literals", () => {
    const split = `const B="ABCDEFGHIJKLM"+"NOPQRSTUVWXYZ"+"abcdefghijklm"+"nopqrstuvwxyz"+"0123456789+/";`;
    expect(detectHandRolledCodec(split)).toEqual({ found: true, kind: "base64" });
  });

  test("flags a base32 alphabet split across concatenated string literals", () => {
    expect(detectHandRolledCodec(`const B="ABCDEFGHIJKLMNOPQRSTUVWXYZ"+"234567";`)).toEqual({
      found: true,
      kind: "base32",
    });
  });

  test("flags a hex table split across concatenated string literals", () => {
    expect(detectHandRolledCodec(`const H="0123456789"+"abcdef";`)).toEqual({
      found: true,
      kind: "hex_table",
    });
  });

  test("flags a reverse-lookup table split across concatenated object literals", () => {
    const split = "const r={A:0,B:1,C:2,D:3}+{E:4,F:5,G:6,H:7,I:8};return r;";
    expect(detectHandRolledCodec(split)).toEqual({ found: true, kind: "reverse_lookup" });
  });

  test("does NOT flag ordinary string concatenation (no codec alphabet)", () => {
    expect(detectHandRolledCodec(`const msg="Hello "+"world, "+"all good";return msg;`)).toEqual({
      found: false,
      kind: null,
    });
  });
});

describe("evaluateTransformAuthoringGate — hand-rolled codec", () => {
  const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  test("blocks a transform that embeds a base64 alphabet, with a sk.base64 steer", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            expression: `const B="${B64_STD}";let o="";return o;`,
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
    const msg = describeTransformGateBlock(block!);
    expect(msg).toContain("sk.base64Encode");
    expect(msg).toContain("encode");
  });

  test("steers a hex_table block to sk.hexEncode", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "hex",
            kind: "transform",
            expression: `const HEX="0123456789abcdef";return HEX;`,
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.codec_kind).toBe("hex_table");
    expect(describeTransformGateBlock(result.blocks[0]!)).toContain("sk.hexEncode");
  });

  test("does NOT block a transform that calls sk.base64Encode", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            expression: "return sk.base64Encode(input.input.payload);",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("does NOT block a transform carrying a long base64 DATA literal", () => {
    const result = evaluateTransformAuthoringGate(
      {
        steps: [
          {
            id: "fixture",
            kind: "transform",
            expression:
              "const asset='SGVsbG8sIHdvcmxkISBUaGlzIGlzIGEgZml4dHVyZSBwYXlsb2FkLg=='; return asset;",
          },
        ],
      },
      null,
    );
    expect(result.ok).toBe(true);
  });

  test("a codec block fires regardless of step references / preview", () => {
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
      {
        ok: true,
        summary: "ok",
        step_traces: [],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("hand_rolled_codec_alphabet");
  });
});
