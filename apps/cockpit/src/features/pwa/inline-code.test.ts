import { describe, expect, test } from "bun:test";
import { inlineCodeParts } from "./inline-code";

describe("inline code in release notes", () => {
  test("backtick spans become code parts", () => {
    expect(inlineCodeParts("The `loop` step kind is removed.")).toEqual([
      { kind: "text", value: "The " },
      { kind: "code", value: "loop" },
      { kind: "text", value: " step kind is removed." },
    ]);
    expect(inlineCodeParts("`graphql`, `sql`")).toEqual([
      { kind: "code", value: "graphql" },
      { kind: "text", value: ", " },
      { kind: "code", value: "sql" },
    ]);
  });

  test("keeps code text exactly, including markup characters", () => {
    expect(inlineCodeParts("Run `subkit vault attach <slug> --env prod` now")[1]).toEqual({
      kind: "code",
      value: "subkit vault attach <slug> --env prod",
    });
  });

  test("an unmatched or empty backtick stays literal text", () => {
    expect(inlineCodeParts("plain note")).toEqual([{ kind: "text", value: "plain note" }]);
    expect(inlineCodeParts("a ` lone tick")).toEqual([{ kind: "text", value: "a ` lone tick" }]);
    expect(inlineCodeParts("empty `` pair and `x`")).toEqual([
      { kind: "text", value: "empty `` pair and " },
      { kind: "code", value: "x" },
    ]);
    expect(inlineCodeParts("")).toEqual([]);
  });
});
