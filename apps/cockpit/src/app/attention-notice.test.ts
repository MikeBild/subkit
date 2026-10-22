import { describe, expect, test } from "bun:test";
import { ATTENTION_TOAST_ID, attentionWorker, handleAttentionMessage } from "./attention-notice";

const origin = "https://app.example.test";

function harness(overview = false) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      origin,
      overview: () => overview,
      invalidate: () => calls.push("invalidate"),
      notify: () => calls.push("notify"),
    },
  };
}

const worker = (path: string, at = origin) => ({ scriptURL: `${at}${path}` });

describe("attention notice", () => {
  test("accepts only the root and installed Cockpit workers of this origin", () => {
    expect(attentionWorker(worker("/cockpit/sw.js"), origin)).toBeTrue();
    expect(
      attentionWorker(worker("/cockpit/i/11111111-1111-4111-8111-111111111111/sw.js"), origin),
    ).toBeTrue();
    expect(attentionWorker(worker("/cockpit/sw.js", "https://other.example.test"), origin)).toBe(
      false,
    );
    expect(attentionWorker(worker("/cockpit/i/a/b/sw.js"), origin)).toBeFalse();
    expect(attentionWorker(worker("/sw.js"), origin)).toBeFalse();
    expect(attentionWorker({ scriptURL: "not a url" }, origin)).toBeFalse();
    expect(attentionWorker(null, origin)).toBeFalse();
    expect(attentionWorker({ postMessage() {} }, origin)).toBeFalse();
  });

  test("ignores other message types and foreign sources", () => {
    const { calls, deps } = harness();
    expect(
      handleAttentionMessage(
        { data: { type: "incoming" }, source: worker("/cockpit/sw.js") },
        deps,
      ),
    ).toBeFalse();
    expect(
      handleAttentionMessage({ data: "attention", source: worker("/cockpit/sw.js") }, deps),
    ).toBe(false);
    expect(
      handleAttentionMessage(
        { data: { type: "attention" }, source: worker("/cockpit/sw.js", "https://evil.test") },
        deps,
      ),
    ).toBeFalse();
    expect(handleAttentionMessage({ data: { type: "attention" }, source: null }, deps)).toBeFalse();
    expect(calls).toEqual([]);
  });

  test("a worker hint refreshes attention and shows one toast", () => {
    const { calls, deps } = harness();
    expect(
      handleAttentionMessage(
        { data: { type: "attention" }, source: worker("/cockpit/sw.js") },
        deps,
      ),
    ).toBeTrue();
    expect(calls).toEqual(["invalidate", "notify"]);
    expect(ATTENTION_TOAST_ID).toBe("cockpit-attention");
  });

  test("on the overview it refreshes without a toast", () => {
    const { calls, deps } = harness(true);
    handleAttentionMessage(
      {
        data: { type: "attention" },
        source: worker("/cockpit/i/11111111-1111-4111-8111-111111111111/sw.js"),
      },
      deps,
    );
    expect(calls).toEqual(["invalidate"]);
  });
});
