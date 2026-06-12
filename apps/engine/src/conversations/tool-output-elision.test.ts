// Within-turn tool-output elision (Fix 7, session 784c1b02). One live
// turn of 40+ agentic iterations re-sent the FULL tool-output history
// on every LLM call — persist.ts only elides across user-turns. The
// shared elision helper stubs bulky (>4KB serialized) tool results
// that are more than WITHIN_TURN_VERBATIM_ITERATIONS iterations old
// with the same `_raw_ref` stub the cross-turn path emits, and the
// model recovers any stubbed payload via `get_raw_result(ref)`.

import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  buildElidedToolOutputStub,
  elideWithinTurnToolOutputs,
  TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS,
  WITHIN_TURN_VERBATIM_ITERATIONS,
} from "./tool-output-elision.ts";
import { clearRawStore, getRawResult } from "./tools/truncate.ts";

afterEach(() => {
  clearRawStore();
});

const BIG_PAYLOAD = () => ({ data: "x".repeat(TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS + 1000) });
const SMALL_PAYLOAD = () => ({ data: "small" });

/** One agentic iteration: assistant tool-call + tool result. */
function iteration(i: number, payload: unknown, tool = "inspect_workflow_draft"): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `call_${i}`, toolName: tool, input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${i}`,
          toolName: tool,
          output: { type: "json", value: payload as never },
        },
      ],
    },
  ];
}

function toolResultValue(msg: ModelMessage | undefined): unknown {
  if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) return undefined;
  const part = msg.content[0];
  if (!part || part.type !== "tool-result") return undefined;
  const output = part.output as { type: string; value: unknown };
  return output.value;
}

function buildTurn(payloads: unknown[]): { messages: ModelMessage[]; baseline: number } {
  const history: ModelMessage[] = [{ role: "user", content: "build the workflow" }];
  const baseline = history.length;
  const live = payloads.flatMap((p, i) => iteration(i, p));
  return { messages: [...history, ...live], baseline };
}

describe("elideWithinTurnToolOutputs", () => {
  test("stubs >4KB outputs older than the verbatim window; get_raw_result recovers them", () => {
    const payloads = Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS + 2 }, () =>
      BIG_PAYLOAD(),
    );
    const { messages, baseline } = buildTurn(payloads);
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: baseline });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected elision");
    // 7 iterations, keep 5 → the 2 oldest are elided.
    expect(result.elided_count).toBe(2);
    for (const idx of [0, 1]) {
      // tool message of iteration idx sits at baseline + idx*2 + 1.
      const stub = toolResultValue(result.messages[baseline + idx * 2 + 1]) as Record<
        string,
        unknown
      >;
      expect(stub._elided).toBe(true);
      expect(stub._tool).toBe("inspect_workflow_draft");
      expect(typeof stub._raw_ref).toBe("string");
      // Persisted-stub convention — the model recognises the wording
      // regardless of which path elided.
      expect(stub._note).toMatch(
        /^<elided: tool=inspect_workflow_draft, ref=raw_[0-9a-f]{8}, original=\d+ chars; call get_raw_result\(ref="raw_[0-9a-f]{8}"\) for the full payload>$/,
      );
      // Full payload recoverable via the existing get_raw_result tool.
      expect(getRawResult(stub._raw_ref as string)).toEqual(payloads[idx]);
    }
  });

  test("keeps the most recent WITHIN_TURN_VERBATIM_ITERATIONS verbatim regardless of size", () => {
    const payloads = Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS + 1 }, () =>
      BIG_PAYLOAD(),
    );
    const { messages, baseline } = buildTurn(payloads);
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: baseline });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected elision");
    expect(result.elided_count).toBe(1);
    // Iterations 1..5 (the last five) stay verbatim.
    for (let idx = 1; idx <= WITHIN_TURN_VERBATIM_ITERATIONS; idx++) {
      expect(toolResultValue(result.messages[baseline + idx * 2 + 1])).toEqual(payloads[idx]!);
    }
  });

  test("outputs ≤4KB stay verbatim even when old", () => {
    const payloads = [
      SMALL_PAYLOAD(),
      BIG_PAYLOAD(),
      ...Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS }, () => SMALL_PAYLOAD()),
    ];
    const { messages, baseline } = buildTurn(payloads);
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: baseline });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected elision");
    expect(result.elided_count).toBe(1);
    // Old-but-small iteration 0 untouched; old-and-big iteration 1 stubbed.
    expect(toolResultValue(result.messages[baseline + 1])).toEqual(payloads[0]!);
    const stub = toolResultValue(result.messages[baseline + 3]) as Record<string, unknown>;
    expect(stub._elided).toBe(true);
  });

  test("returns null when no live iteration crosses the window or threshold", () => {
    // Fewer iterations than the window → nothing to do.
    const few = buildTurn(
      Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS }, () => BIG_PAYLOAD()),
    );
    expect(elideWithinTurnToolOutputs(few.messages, { baseline_index: few.baseline })).toBeNull();
    // Enough iterations, all small → nothing crosses the threshold.
    const small = buildTurn(
      Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS + 3 }, () => SMALL_PAYLOAD()),
    );
    expect(
      elideWithinTurnToolOutputs(small.messages, { baseline_index: small.baseline }),
    ).toBeNull();
  });

  test("replayed history before baseline_index is never touched", () => {
    // Bulky tool result in the replayed history — persist.ts owns that
    // window; the within-turn pass must leave it alone.
    const historyPayload = BIG_PAYLOAD();
    const history: ModelMessage[] = [
      { role: "user", content: "earlier turn" },
      ...iteration(99, historyPayload),
    ];
    const livePayloads = Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS + 1 }, () =>
      BIG_PAYLOAD(),
    );
    const messages = [...history, ...livePayloads.flatMap((p, i) => iteration(i, p))];
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: history.length });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected elision");
    // History tool message (index 2) is verbatim.
    expect(toolResultValue(result.messages[2])).toEqual(historyPayload);
    expect(result.elided_count).toBe(1);
  });

  test("reuses an existing _raw_ref instead of minting a fresh one", () => {
    const payloadWithRef = {
      data: "x".repeat(TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS + 1000),
      _truncated: true,
      _raw_ref: "raw_existing",
    };
    const payloads = [
      payloadWithRef,
      ...Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS }, () => SMALL_PAYLOAD()),
    ];
    const { messages, baseline } = buildTurn(payloads);
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: baseline });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected elision");
    const stub = toolResultValue(result.messages[baseline + 1]) as Record<string, unknown>;
    expect(stub._raw_ref).toBe("raw_existing");
    expect(stub._note).toContain('get_raw_result(ref="raw_existing")');
  });

  test("never double-stubs an already-elided payload", () => {
    const alreadyElided = buildElidedToolOutputStub({
      tool: "inspect_workflow_draft",
      ref: "raw_prior",
      original_size: 99999,
      size_unit: "chars",
    });
    const payloads = [
      alreadyElided,
      ...Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS }, () => SMALL_PAYLOAD()),
    ];
    const { messages, baseline } = buildTurn(payloads);
    expect(elideWithinTurnToolOutputs(messages, { baseline_index: baseline })).toBeNull();
  });

  test("copy-on-write: the input messages are not mutated", () => {
    const payloads = Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS + 1 }, () =>
      BIG_PAYLOAD(),
    );
    const { messages, baseline } = buildTurn(payloads);
    const snapshot = JSON.stringify(messages);
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: baseline });
    expect(result).not.toBeNull();
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(result?.messages).not.toBe(messages);
  });

  test("bulky text outputs are stubbed too", () => {
    const bigText = "y".repeat(TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS + 500);
    const history: ModelMessage[] = [{ role: "user", content: "go" }];
    const live: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_t", toolName: "fetch_docs", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_t",
            toolName: "fetch_docs",
            output: { type: "text", value: bigText },
          },
        ],
      },
      ...Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS }, (_, i) =>
        iteration(i, SMALL_PAYLOAD()),
      ).flat(),
    ];
    const messages = [...history, ...live];
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: history.length });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected elision");
    const stub = toolResultValue(result.messages[2]) as Record<string, unknown>;
    expect(stub._elided).toBe(true);
    expect(stub._tool).toBe("fetch_docs");
    expect(getRawResult(stub._raw_ref as string)).toBe(bigText);
  });
});

describe("buildElidedToolOutputStub", () => {
  test("matches the persisted-stub convention for both size units", () => {
    expect(
      buildElidedToolOutputStub({
        tool: "list_users",
        ref: "raw_abcd1234",
        original_size: 12345,
        size_unit: "bytes",
      })._note,
    ).toBe(
      '<elided: tool=list_users, ref=raw_abcd1234, original=12345 bytes; call get_raw_result(ref="raw_abcd1234") for the full payload>',
    );
    expect(
      buildElidedToolOutputStub({
        tool: "list_users",
        ref: "raw_abcd1234",
        original_size: 12345,
        size_unit: "chars",
      })._note,
    ).toBe(
      '<elided: tool=list_users, ref=raw_abcd1234, original=12345 chars; call get_raw_result(ref="raw_abcd1234") for the full payload>',
    );
  });
});
