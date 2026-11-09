import { expect, test } from "bun:test";
import { embeddingsAvailable, embedTexts } from "../local-provider.ts";

test("the real embedding worker returns normalized aligned vectors while the main loop runs", async () => {
  expect(await embeddingsAvailable()).toBe(true);
  const text = "A customer needs a receipt for the paid invoice. ".repeat(100);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const result = await embedTexts([text, "Hallo Welt", text]);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(384);
    expect(result[1]).toHaveLength(384);
    expect(result[0]).toEqual(result[2]);
    for (const vector of result) {
      expect(vector.every(Number.isFinite)).toBe(true);
      expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 4);
    }
    expect(ticks).toBeGreaterThan(1);
  } finally {
    clearInterval(timer);
  }
}, 120_000);
