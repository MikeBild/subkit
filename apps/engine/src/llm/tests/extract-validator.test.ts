import { describe, expect, it } from "bun:test";
import { validateExtractRoundtrip } from "../flows/extract.ts";

describe("validateExtractRoundtrip", () => {
  it("accepts a complete object roundtrip", () => {
    const r = validateExtractRoundtrip(
      { type: "object", required: ["a"], properties: { a: { type: "string" } } },
      { a: "ok" },
    );
    expect(r.status).toBe("ok");
    expect(r.issues).toEqual([]);
  });

  it("fails when required field is missing from data", () => {
    const r = validateExtractRoundtrip(
      { type: "object", required: ["a", "b"], properties: {} },
      { a: "ok" },
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.includes('"b"'))).toBe(true);
  });

  it("fails when schema.type=object but data is array", () => {
    const r = validateExtractRoundtrip({ type: "object" }, [1, 2, 3]);
    expect(r.status).toBe("fail");
  });

  it("fails when schema.type=array but data is object", () => {
    const r = validateExtractRoundtrip({ type: "array" }, { x: 1 });
    expect(r.status).toBe("fail");
  });

  it("accepts primitive matches", () => {
    expect(validateExtractRoundtrip({ type: "string" }, "x").status).toBe("ok");
    expect(validateExtractRoundtrip({ type: "number" }, 7).status).toBe("ok");
    expect(validateExtractRoundtrip({ type: "boolean" }, true).status).toBe("ok");
    expect(validateExtractRoundtrip({ type: "null" }, null).status).toBe("ok");
    expect(validateExtractRoundtrip({ type: "integer" }, 42).status).toBe("ok");
  });

  it("returns unverified when schema is null/undefined/not-object", () => {
    expect(validateExtractRoundtrip(null, {}).status).toBe("unverified");
    expect(validateExtractRoundtrip(undefined, {}).status).toBe("unverified");
    expect(validateExtractRoundtrip("not a schema", {}).status).toBe("unverified");
  });

  it("returns unverified when schema.type is unrecognised", () => {
    expect(validateExtractRoundtrip({ type: "weird-custom-type" }, {}).status).toBe("unverified");
    expect(validateExtractRoundtrip({ properties: { a: {} } }, {}).status).toBe("unverified");
  });
});
