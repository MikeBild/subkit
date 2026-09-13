import { describe, expect, test } from "bun:test";

import { computeConfidence } from "../types.ts";

describe("skill-candidates/computeConfidence", () => {
  test("low confidence for < 5 evidence", () => {
    expect(computeConfidence(3, 0.9)).toBe("low");
    expect(computeConfidence(4, 1.0)).toBe("low");
  });

  test("low confidence for low ratio", () => {
    expect(computeConfidence(10, 0.5)).toBe("low");
    expect(computeConfidence(20, 0.7)).toBe("low");
  });

  test("medium confidence for 5+ evidence and 0.8+ ratio", () => {
    expect(computeConfidence(5, 0.8)).toBe("medium");
    expect(computeConfidence(7, 0.85)).toBe("medium");
  });

  test("high confidence for 8+ evidence and 0.9+ ratio", () => {
    expect(computeConfidence(8, 0.9)).toBe("high");
    expect(computeConfidence(20, 0.95)).toBe("high");
  });

  test("boundary: exactly 8 evidence, exactly 0.9 ratio", () => {
    expect(computeConfidence(8, 0.9)).toBe("high");
  });

  test("boundary: exactly 5 evidence, exactly 0.8 ratio", () => {
    expect(computeConfidence(5, 0.8)).toBe("medium");
  });

  test("boundary: 7 evidence, 0.89 ratio (medium not high)", () => {
    expect(computeConfidence(7, 0.89)).toBe("medium");
  });

  test("zero evidence", () => {
    expect(computeConfidence(0, 0)).toBe("low");
  });

  test("zero ratio with high count", () => {
    expect(computeConfidence(100, 0)).toBe("low");
  });
});
