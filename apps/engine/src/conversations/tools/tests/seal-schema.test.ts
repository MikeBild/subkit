import { describe, expect, it } from "bun:test";
import { z } from "@hono/zod-openapi";
import { sealSchema } from "../seal-schema.ts";

describe("sealSchema", () => {
  it("rejects unknown keys on a ZodObject after sealing", () => {
    const sealed = sealSchema(z.object({ name: z.string() }));
    const r = sealed.safeParse({ name: "ok", extra: "boom" });
    expect(r.success).toBe(false);
  });

  it("still accepts the canonical input shape", () => {
    const sealed = sealSchema(z.object({ name: z.string() }));
    expect(sealed.parse({ name: "ok" })).toEqual({ name: "ok" });
  });

  it("is idempotent — sealing twice still rejects extras", () => {
    const once = sealSchema(z.object({ a: z.number() }));
    const twice = sealSchema(once);
    expect(twice.safeParse({ a: 1, b: 2 }).success).toBe(false);
  });

  it("passes non-object schemas through unchanged", () => {
    const arr = z.array(z.string());
    const sealed = sealSchema(arr);
    expect(sealed).toBe(arr);
    expect(sealed.parse(["a", "b"])).toEqual(["a", "b"]);
  });

  it("works on ZodObject with optional fields", () => {
    const sealed = sealSchema(z.object({ a: z.string(), b: z.number().optional() }));
    expect(sealed.parse({ a: "x" })).toEqual({ a: "x" });
    expect(sealed.parse({ a: "x", b: 7 })).toEqual({ a: "x", b: 7 });
    expect(sealed.safeParse({ a: "x", c: "extra" }).success).toBe(false);
  });

  it("preserves the .openapi metadata wrapper", () => {
    const sealed = sealSchema(z.object({ a: z.string() }).openapi("FooInput"));
    expect(sealed.parse({ a: "ok" })).toEqual({ a: "ok" });
    expect(sealed.safeParse({ a: "ok", extra: 1 }).success).toBe(false);
  });
});
