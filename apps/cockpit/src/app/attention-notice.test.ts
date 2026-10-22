import { describe, expect, test } from "bun:test";
import { ATTENTION_TOAST_ID, attentionWorker, handleAttentionMessage } from "./attention-notice";

const origin = "https://app.example.test";

const installed = "/cockpit/i/11111111-1111-4111-8111-111111111111";

function harness(overview = false, basePath = "/cockpit") {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      origin,
      basePath,
      overview: () => overview,
      invalidate: () => calls.push("invalidate"),
      notify: () => calls.push("notify"),
    },
  };
}

const worker = (path: string, at = origin) => ({ scriptURL: `${at}${path}` });

describe("attention notice", () => {
  test("accepts only the worker of this page's own Cockpit scope and origin", () => {
    expect(attentionWorker(worker("/cockpit/sw.js"), origin, "/cockpit")).toBeTrue();
    expect(attentionWorker(worker(`${installed}/sw.js`), origin, installed)).toBeTrue();
    expect(attentionWorker(worker(`${installed}/sw.js`), origin, "/cockpit")).toBeFalse();
    expect(attentionWorker(worker("/cockpit/sw.js"), origin, installed)).toBeFalse();
    expect(
      attentionWorker(
        worker("/cockpit/i/22222222-2222-4222-8222-222222222222/sw.js"),
        origin,
        installed,
      ),
    ).toBeFalse();
    expect(
      attentionWorker(worker("/cockpit/sw.js", "https://other.example.test"), origin, "/cockpit"),
    ).toBeFalse();
    expect(attentionWorker(worker("/sw.js"), origin, "/cockpit")).toBeFalse();
    expect(attentionWorker({ scriptURL: "not a url" }, origin, "/cockpit")).toBeFalse();
    expect(attentionWorker(null, origin, "/cockpit")).toBeFalse();
    expect(attentionWorker({ postMessage() {} }, origin, "/cockpit")).toBeFalse();
  });

  test("a hint from another workspace's worker shows nothing", () => {
    const { calls, deps } = harness(false, "/cockpit");
    expect(
      handleAttentionMessage(
        { data: { type: "attention" }, source: worker(`${installed}/sw.js`) },
        deps,
      ),
    ).toBeFalse();
    expect(calls).toEqual([]);
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
        {
          data: { type: "attention" },
          source: worker("/cockpit/sw.js", "https://evil.test"),
        },
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
    const { calls, deps } = harness(true, installed);
    handleAttentionMessage(
      {
        data: { type: "attention" },
        source: worker(`${installed}/sw.js`),
      },
      deps,
    );
    expect(calls).toEqual(["invalidate"]);
  });
});
