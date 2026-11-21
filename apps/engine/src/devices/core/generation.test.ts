import { describe, expect, test } from "bun:test";
import {
  commandGenerationCurrent,
  mergedStopGeneration,
  nextCommandGeneration,
  stopReportIsNew,
} from "./generation.ts";

describe("the stop generation of a device", () => {
  test("a new command carries the stored generation, never less", () => {
    expect(nextCommandGeneration(0)).toBe(0);
    expect(nextCommandGeneration(7)).toBe(7);
    expect(commandGenerationCurrent(7, nextCommandGeneration(7))).toBe(true);
    expect(commandGenerationCurrent(7, 8)).toBe(true);
    expect(commandGenerationCurrent(7, 6)).toBe(false);
  });

  test("it only ever goes up", () => {
    expect(mergedStopGeneration(3, 5)).toBe(5);
    expect(mergedStopGeneration(5, 3)).toBe(5);
    expect(mergedStopGeneration(5, 5)).toBe(5);
  });

  test("a stop report is recorded once", () => {
    expect(stopReportIsNew(0, 1)).toBe(true);
    expect(stopReportIsNew(1, 1)).toBe(false);
    expect(stopReportIsNew(2, 1)).toBe(false);
  });

  test("a negative, fractional or unsafe generation is refused", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => nextCommandGeneration(bad)).toThrow(RangeError);
      expect(() => nextCommandGeneration(bad)).toThrow("invalid stop generation");
      expect(() => mergedStopGeneration(0, bad)).toThrow(RangeError);
      expect(() => mergedStopGeneration(bad, 0)).toThrow(RangeError);
      expect(() => commandGenerationCurrent(bad, 0)).toThrow(RangeError);
      expect(() => commandGenerationCurrent(0, bad)).toThrow(RangeError);
      expect(() => stopReportIsNew(bad, 0)).toThrow(RangeError);
      expect(() => stopReportIsNew(0, bad)).toThrow(RangeError);
    }
  });
});
