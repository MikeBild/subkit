import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { clearRawStore, getRawResult } from "../tools/truncate.ts";
import {
  buildElidedToolOutputStub,
  elideWithinTurnToolOutputs,
  isReplayCriticalToolOutput,
  TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS,
  WITHIN_TURN_VERBATIM_ITERATIONS,
} from "./tool-output-elision.ts";

afterEach(() => {
  clearRawStore();
});

const BIG_PAYLOAD = () => ({ data: "x".repeat(TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS + 1000) });
const SMALL_PAYLOAD = () => ({ data: "small" });

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
  if (msg?.role !== "tool" || !Array.isArray(msg.content)) return undefined;
  const part = msg.content[0];
  if (part?.type !== "tool-result") return undefined;
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
    expect(result.elided_count).toBe(2);
    for (const idx of [0, 1]) {
      const stub = toolResultValue(result.messages[baseline + idx * 2 + 1]) as Record<
        string,
        unknown
      >;
      expect(stub._elided).toBe(true);
      expect(stub._tool).toBe("inspect_workflow_draft");
      expect(typeof stub._raw_ref).toBe("string");
      expect(stub._note).toMatch(
        /^<elided: tool=inspect_workflow_draft, ref=raw_[0-9a-f]{8}, original=\d+ chars; call get_raw_result\(ref="raw_[0-9a-f]{8}"\) and follow its bounded field retrieval instructions>$/,
      );
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
    expect(toolResultValue(result.messages[baseline + 1])).toEqual(payloads[0]!);
    const stub = toolResultValue(result.messages[baseline + 3]) as Record<string, unknown>;
    expect(stub._elided).toBe(true);
  });

  test("returns null when no live iteration crosses the window or threshold", () => {
    const few = buildTurn(
      Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS }, () => BIG_PAYLOAD()),
    );
    expect(elideWithinTurnToolOutputs(few.messages, { baseline_index: few.baseline })).toBeNull();
    const small = buildTurn(
      Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS + 3 }, () => SMALL_PAYLOAD()),
    );
    expect(
      elideWithinTurnToolOutputs(small.messages, { baseline_index: small.baseline }),
    ).toBeNull();
  });

  test("replayed history before baseline_index is never touched", () => {
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
      '<elided: tool=list_users, ref=raw_abcd1234, original=12345 bytes; call get_raw_result(ref="raw_abcd1234") and follow its bounded field retrieval instructions>',
    );
    expect(
      buildElidedToolOutputStub({
        tool: "list_users",
        ref: "raw_abcd1234",
        original_size: 12345,
        size_unit: "chars",
      })._note,
    ).toBe(
      '<elided: tool=list_users, ref=raw_abcd1234, original=12345 chars; call get_raw_result(ref="raw_abcd1234") and follow its bounded field retrieval instructions>',
    );
  });
});

describe("isReplayCriticalToolOutput", () => {
  test("retains failed saves and held writes in the replay", () => {
    expect(isReplayCriticalToolOutput({ ok: false, error_code: "draft_conflict" })).toBe(true);
    expect(isReplayCriticalToolOutput({ writes_held: true })).toBe(true);
    expect(isReplayCriticalToolOutput({ data: { status: "failed" } })).toBe(true);
    expect(isReplayCriticalToolOutput({ ok: true, payload: "x".repeat(10_000) })).toBe(false);
  });

  test("compacts critical evidence without dropping the failure status", () => {
    const messages = [
      ...iteration(0, {
        ok: false,
        error_code: "draft_conflict",
        message: "The saved draft changed elsewhere.",
        held_step_ids: ["write_customer"],
        workflow_id: "workflow_1",
        workflow_version_id: "version_2",
        resource_ids: ["resource_3"],
        payload: "x".repeat(TOOL_OUTPUT_ELIDE_THRESHOLD_CHARS + 1_000),
      }),
      ...Array.from({ length: WITHIN_TURN_VERBATIM_ITERATIONS }, (_, index) =>
        iteration(index + 1, SMALL_PAYLOAD()),
      ).flat(),
    ];
    const result = elideWithinTurnToolOutputs(messages, { baseline_index: 0 });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected elision");
    const stub = toolResultValue(result.messages[1]) as Record<string, unknown>;
    expect(stub).toMatchObject({
      _elided: true,
      _critical: true,
      ok: false,
      error_code: "draft_conflict",
      message: "The saved draft changed elsewhere.",
      held_step_ids: ["write_customer"],
      workflow_id: "workflow_1",
      workflow_version_id: "version_2",
      resource_ids: ["resource_3"],
    });
    expect(JSON.stringify(stub).length).toBeLessThan(1_000);
  });
});
