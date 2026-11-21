import { describe, expect, test } from "bun:test";
import { answerPhase, bubbleContinues, bubbleSide, previousSides } from "./bubble-model";

describe("chat bubbles", () => {
  test("your messages are answers on the right, SubKit's sit left", () => {
    expect(bubbleSide("user")).toBe("answer");
    expect(bubbleSide("assistant")).toBe("subkit");
    expect(bubbleSide("system")).toBe("system");
    expect(bubbleSide("tool")).toBe("system");
  });

  test("a bubble continues the one above from the same side", () => {
    expect(bubbleContinues(null, "subkit")).toBe(false);
    expect(bubbleContinues("subkit", "subkit")).toBe(true);
    expect(bubbleContinues("answer", "answer")).toBe(true);
    expect(bubbleContinues("answer", "subkit")).toBe(false);
  });

  test("system lines never merge into a run", () => {
    expect(bubbleContinues("system", "system")).toBe(false);
  });

  test("each message knows the side above it", () => {
    const spoke = (role: string) => ({ role, spoke: true });
    expect(previousSides(["user", "assistant", "assistant", "user"].map(spoke))).toEqual([
      null,
      "answer",
      "subkit",
      "subkit",
    ]);
    expect(previousSides([])).toEqual([]);
  });

  test("a message with only a card above keeps the SubKit mark", () => {
    expect(
      previousSides([
        { role: "assistant", spoke: false },
        { role: "assistant", spoke: true },
      ]),
    ).toEqual([null, null]);
  });
});

describe("answer start", () => {
  test("nothing shows before you send", () => {
    expect(answerPhase({ sendPending: false, streamedText: "", liveCalls: 0 })).toBe("none");
  });

  test("a sent message waits with a skeleton until the first token", () => {
    expect(answerPhase({ sendPending: true, streamedText: "", liveCalls: 0 })).toBe("waiting");
  });

  test("a running tool shows its own line instead of the skeleton", () => {
    expect(answerPhase({ sendPending: true, streamedText: "", liveCalls: 1 })).toBe("none");
  });

  test("the first token switches to the streamed text", () => {
    expect(answerPhase({ sendPending: true, streamedText: "Hi", liveCalls: 0 })).toBe("streaming");
    expect(answerPhase({ sendPending: false, streamedText: "Hi", liveCalls: 2 })).toBe("streaming");
  });
});
