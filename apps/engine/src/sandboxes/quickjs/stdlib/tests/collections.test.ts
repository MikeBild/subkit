import { describe, expect, test } from "bun:test";
import { runJs } from "../../runtime.ts";

describe("sk.get / sk.has", () => {
  test("get traverses dotted paths and returns fallback on null chain", async () => {
    const { output } = await runJs<Record<string, unknown>>({
      code: "return { method: sk.get(input, 'request.method'), missing: sk.get(input, 'request.missing', 'fallback'), deep: sk.get(input, 'a.b.c.d', null) };",
      input: { request: { method: "POST" } },
      clock: null,
    });
    expect(output.method).toBe("POST");
    expect(output.missing).toBe("fallback");
    expect(output.deep).toBe(null);
  });

  test("get accepts array path", async () => {
    const { output } = await runJs<string>({
      code: "return sk.get(input, ['request', 'method']);",
      input: { request: { method: "GET" } },
      clock: null,
    });
    expect(output).toBe("GET");
  });

  test("has returns false on missing key", async () => {
    const { output } = await runJs<Record<string, boolean>>({
      code: "return { present: sk.has(input, 'request.method'), absent: sk.has(input, 'request.body') };",
      input: { request: { method: "GET" } },
      clock: null,
    });
    expect(output.present).toBe(true);
    expect(output.absent).toBe(false);
  });
});

describe("sk.pick / sk.omit", () => {
  test("pick returns only requested keys", async () => {
    const { output } = await runJs<Record<string, unknown>>({
      code: "return sk.pick(input, ['a', 'c']);",
      input: { a: 1, b: 2, c: 3 },
      clock: null,
    });
    expect(output).toEqual({ a: 1, c: 3 });
  });

  test("omit removes requested keys", async () => {
    const { output } = await runJs<Record<string, unknown>>({
      code: "return sk.omit(input, ['b']);",
      input: { a: 1, b: 2, c: 3 },
      clock: null,
    });
    expect(output).toEqual({ a: 1, c: 3 });
  });
});

describe("sk.pluck / sk.groupBy / sk.uniq", () => {
  test("pluck extracts a key from each element", async () => {
    const { output } = await runJs<string[]>({
      code: "return sk.pluck(input, 'name');",
      input: [{ name: "a" }, { name: "b" }, { name: "c" }],
      clock: null,
    });
    expect(output).toEqual(["a", "b", "c"]);
  });

  test("groupBy buckets by string key", async () => {
    const { output } = await runJs<Record<string, unknown[]>>({
      code: "return sk.groupBy(input, 'kind');",
      input: [
        { kind: "fruit", name: "apple" },
        { kind: "fruit", name: "banana" },
        { kind: "veg", name: "kale" },
      ],
      clock: null,
    });
    expect(Object.keys(output).sort()).toEqual(["fruit", "veg"]);
    expect((output.fruit as unknown[]).length).toBe(2);
    expect((output.veg as unknown[]).length).toBe(1);
  });

  test("groupBy accepts a function", async () => {
    const { output } = await runJs<Record<string, number[]>>({
      code: "return sk.groupBy(input, function(n){ return n % 2 === 0 ? 'even' : 'odd'; });",
      input: [1, 2, 3, 4, 5],
      clock: null,
    });
    expect(output.odd).toEqual([1, 3, 5]);
    expect(output.even).toEqual([2, 4]);
  });

  test("uniq deduplicates primitives", async () => {
    const { output } = await runJs<unknown[]>({
      code: "return sk.uniq(input);",
      input: [1, 2, 2, 3, "a", "a", null, null, true, true],
      clock: null,
    });
    expect(output).toEqual([1, 2, 3, "a", null, true]);
  });
});

describe("sk type guards", () => {
  test("classifies common values", async () => {
    const { output } = await runJs<Record<string, boolean>>({
      code: "return { str: sk.isString('x'), num: sk.isNumber(3), arr: sk.isArray([1]), obj: sk.isObject({}), nil: sk.isNil(null), notObj: sk.isObject([]), nanIsNumber: sk.isNumber(NaN) };",
      input: null,
      clock: null,
    });
    expect(output).toEqual({
      str: true,
      num: true,
      arr: true,
      obj: true,
      nil: true,
      notObj: false,
      nanIsNumber: false,
    });
  });
});

describe("sk immutability", () => {
  test("sk global is frozen and cannot be replaced or mutated", async () => {
    const { output } = await runJs<{ skAllow: string; skDenyAllow: unknown; frozen: boolean }>({
      code: `
        try { globalThis.sk = { allow: 'hacked' }; } catch (e) {}
        try { sk.allow = 'hacked'; } catch (e) {}
        var probe = sk.allow();
        return { skAllow: typeof sk.allow, skDenyAllow: probe.allow, frozen: Object.isFrozen(sk) };
      `,
      input: null,
      clock: null,
    });
    expect(output.skAllow).toBe("function");
    expect(output.skDenyAllow).toBe(true);
    expect(output.frozen).toBe(true);
  });

  test("sk.version is set", async () => {
    const { output } = await runJs<string>({
      code: "return sk.version;",
      input: null,
      clock: null,
    });
    expect(output).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
