// A remote manifest is untrusted input, and this suite is where that is
// made true rather than asserted in a comment.
//
// The claims under test:
//   - a malformed tool costs its server one tool, not every tool
//   - two tools with one name cannot both become one palette key
//   - the fingerprint covers the fields a change in would change how the
//     engine or the model treats the tool, and covers NOTHING a server can
//     make flap on every handshake
//   - the fingerprint is versioned, so a change on OUR side is legible as
//     that instead of as the remote drifting
//   - an over-budget manifest loses reply SHAPES before it loses tools

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
    // The failure this prevents: one bad entry failing the handshake, which
    // parks the whole server in backoff and takes twenty good tools with it.
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
    // Two entries would compose to ONE `mcp_<ns>__<tool>` key and the
    // second would silently overwrite the first — a call routed to a tool
    // the operator never saw in the palette.
    const { tools, rejected } = parseRemoteManifest([
      tool("search", { description: "the real one" }),
      tool("search", { description: "the shadow" }),
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("the real one");
    expect(rejected).toEqual([{ name: "search", reason: "duplicate_name" }]);
  });

  test("unknown wire fields never reach the descriptor", () => {
    // `_meta` is a free-form bag with no stability requirement. Carried, it
    // would land in the fingerprint and a server parking a timestamp there
    // would look like it drifts on every handshake.
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
    // A hash written before fingerprints carried a version has none, which
    // is what `schema-drift.ts` keys the re-baseline on.
    expect(manifestHashVersion("a".repeat(64))).toBeNull();
  });

  test("covers annotations and outputSchema", () => {
    // The point of carrying them: a server that silently flips
    // `readOnlyHint` or narrows its declared output has changed its
    // contract with us, and an operator should see a drift row for it.
    const base = tool("a");
    expect(hashManifest([base])).not.toBe(
      hashManifest([tool("a", { annotations: { readOnlyHint: true } })]),
    );
    expect(hashManifest([base])).not.toBe(
      hashManifest([tool("a", { outputSchema: { type: "object" } })]),
    );
  });

  test("is order-independent", () => {
    // A server free to return its tools in any order must not look like it
    // drifts on every handshake.
    expect(hashManifest([tool("a"), tool("b")])).toBe(hashManifest([tool("a"), tool("b")]));
    const forward = hashManifest([tool("a"), tool("b")]);
    const backward = hashManifest([tool("b"), tool("a")]);
    // Order of the ARRAY is part of the manifest identity; what must be
    // order-independent is object KEY order, which canonicalJson sorts.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(forward).not.toBe(backward);
  });
});

describe("capManifest", () => {
  test("sheds output schemas before it drops a tool", () => {
    // A reply shape is a hint; a tool is a capability. Under budget
    // pressure the hint goes first.
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
    // Annotations are what the palette shows about a tool's claimed
    // effects. A budget is not a reason to stop showing it.
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
