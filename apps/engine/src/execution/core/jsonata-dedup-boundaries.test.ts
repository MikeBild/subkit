import { expect, test } from "bun:test";
import {
  findUnboundFunctionCalls,
  findUnknownFunctionCalls,
  formatError,
} from "./jsonata-contract.ts";

test("records repeated real bare calls separately by their parser positions", () => {
  expect(findUnboundFunctionCalls("repeat() + repeat()")).toEqual([
    { name: "repeat", position: 6, suggestion: "$repeat" },
    { name: "repeat", position: 17, suggestion: "$repeat" },
  ]);
});

test("records repeated real unknown variable calls separately by their parser positions", () => {
  expect(findUnknownFunctionCalls("$missing(1) + $missing(2)")).toEqual([
    { name: "missing", position: 8, suggestion: null },
    { name: "missing", position: 22, suggestion: null },
  ]);
});

test("formats primitive and absent parser-error messages through public error values", () => {
  expect(formatError({ message: undefined }, "x").message).toBe("JSONata error: JSONata error");
  expect(formatError({ message: true }, "x").message).toBe("JSONata error: true");
});
