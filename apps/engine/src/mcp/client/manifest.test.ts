import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  capManifest,
  hashManifest,
  MANIFEST_HASH_VERSION,
  manifestHashVersion,
  parseRemoteManifest,
  type RemoteToolDescriptor,
} from "./manifest.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";

function tool(name: string, extra: Partial<RemoteToolDescriptor> = {}): RemoteToolDescriptor {
  return {
    name,
    description: `does ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

describe("parseRemoteManifest", () => {
  test("carries title, annotations and outputSchema through", () => {
    const { tools, rejected } = parseRemoteManifest([
      {
        name: "search",
        title: "Search the wiki",
        description: "finds pages",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        outputSchema: { type: "object", properties: { hits: { type: "number" } } },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
    ]);
    expect(rejected).toEqual([]);
    expect(tools[0]).toEqual({
      name: "search",
      description: "finds pages",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      title: "Search the wiki",
      outputSchema: { type: "object", properties: { hits: { type: "number" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    });
  });

  test("a malformed tool is dropped and its siblings survive", () => {
    const { tools, rejected } = parseRemoteManifest([
      tool("good_one"),
      { name: "no_schema" },
      { description: "nameless", inputSchema: {} },
      tool("good_two"),
    ]);
    expect(tools.map((t) => t.name)).toEqual(["good_one", "good_two"]);
    expect(rejected).toEqual([
      { name: "no_schema", reason: "malformed" },
      { name: "<unnamed>", reason: "malformed" },
    ]);
  });

  test("a duplicate name is refused, first occurrence wins", () => {
    const { tools, rejected } = parseRemoteManifest([
      tool("search", { description: "the real one" }),
      tool("search", { description: "the shadow" }),
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("the real one");
    expect(rejected).toEqual([{ name: "search", reason: "duplicate_name" }]);
  });

  test("unknown wire fields never reach the descriptor", () => {
    const { tools } = parseRemoteManifest([
      { ...tool("search"), _meta: { requestId: "abc" }, execution: { taskSupport: "optional" } },
    ]);
    expect(Object.keys(tools[0] ?? {}).sort()).toEqual(["description", "inputSchema", "name"]);
  });
});

describe("hashManifest", () => {
  test("is versioned, so an engine-side projection change is not remote drift", () => {
    const h = hashManifest([tool("a")]);
    expect(manifestHashVersion(h)).toBe(MANIFEST_HASH_VERSION);
    expect(manifestHashVersion("a".repeat(64))).toBeNull();
  });

  test("covers annotations and outputSchema", () => {
    const base = tool("a");
    expect(hashManifest([base])).not.toBe(
      hashManifest([tool("a", { annotations: { readOnlyHint: true } })]),
    );
    expect(hashManifest([base])).not.toBe(
      hashManifest([tool("a", { outputSchema: { type: "object" } })]),
    );
  });

  test("is order-independent", () => {
    expect(hashManifest([tool("a"), tool("b")])).toBe(hashManifest([tool("a"), tool("b")]));
    const forward = hashManifest([tool("a"), tool("b")]);
    const backward = hashManifest([tool("b"), tool("a")]);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(forward).not.toBe(backward);
  });
});

describe("capManifest", () => {
  test("sheds output schemas before it drops a tool", () => {
    const fat = {
      type: "object",
      properties: { blob: { type: "string", description: "x".repeat(11_000) } },
    };
    const tools = ["alpha", "bravo", "charlie"].map((n) => tool(n, { outputSchema: fat }));
    const capped = capManifest(TENANT, "ns", SERVER, tools);
    expect(capped.map((t) => t.name)).toEqual(["alpha", "bravo", "charlie"]);
    expect(capped.every((t) => t.outputSchema === undefined)).toBe(true);
  });

  test("annotations survive the cap even when tools are dropped", () => {
    const huge = "y".repeat(20_000);
    const tools = ["alpha", "bravo"].map((n) =>
      tool(n, { description: huge, annotations: { readOnlyHint: true } }),
    );
    const capped = capManifest(TENANT, "ns", SERVER, tools);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.annotations).toEqual({ readOnlyHint: true });
  });

  test("a manifest under the cap is returned untouched", () => {
    const tools = [tool("a", { outputSchema: { type: "object" } })];
    expect(capManifest(TENANT, "ns", SERVER, tools)).toBe(tools);
  });
});
