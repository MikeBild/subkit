import { expect, test } from "bun:test";
import { deduplicateCallSites } from "./jsonata-contract.ts";

test("call-site projection retains the first finding at each name and position", () => {
  const first = Object.freeze({ name: "repeat", position: 0, suggestion: "first" });
  const duplicate = Object.freeze({ name: "repeat", position: 0, suggestion: "second" });
  const later = Object.freeze({ name: "repeat", position: 12, suggestion: "later" });
  const other = Object.freeze({ name: "other", position: 0, suggestion: "other" });
  const calls = Object.freeze([first, later, duplicate, other, first]);
  const result = deduplicateCallSites(calls);
  expect(result).toEqual([first, later, other]);
  expect(result[0]).toBe(first);
  expect(result[1]).toBe(later);
  expect(result[2]).toBe(other);
  expect(result).not.toBe(calls);
  expect(calls).toEqual([first, later, duplicate, other, first]);
});

test("absent positions deduplicate without becoming position zero or changing finding shape", () => {
  const missing = Object.freeze({ name: "call" });
  const explicit = Object.freeze({ name: "call", position: undefined });
  const zero = Object.freeze({ name: "call", position: 0 });
  const different = Object.freeze({ name: "other" });
  expect(deduplicateCallSites([missing, explicit, zero, different])).toEqual([
    missing,
    zero,
    different,
  ]);
  expect(deduplicateCallSites([explicit, missing])[0]).toBe(explicit);
  expect(Object.hasOwn(deduplicateCallSites([missing, explicit])[0]!, "position")).toBe(false);
  expect(deduplicateCallSites([])).toEqual([]);
});
