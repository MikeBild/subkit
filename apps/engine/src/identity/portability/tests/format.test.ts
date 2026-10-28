import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  contentDigest,
  itemPath,
  type PackageManifestItem,
  sha256Hex,
  sortPayloads,
  stableUuid,
} from "../format.ts";

const UUID_V5_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function manifestItem(path: string, sha: string): PackageManifestItem {
  return { kind: "skill", key: path, path, sha256: sha };
}

describe("canonicalJson", () => {
  test("sorts object keys at every depth and keeps array order", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
    const b = canonicalJson({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  test("drops undefined members", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe("contentDigest", () => {
  const a = manifestItem("skills/a.json", "a".repeat(64));
  const b = manifestItem("skills/b.json", "b".repeat(64));

  test("is independent of item order", () => {
    expect(contentDigest([a, b])).toBe(contentDigest([b, a]));
  });

  test("changes when one payload hash changes", () => {
    const changed = { ...b, sha256: "c".repeat(64) };
    expect(contentDigest([a, b])).not.toBe(contentDigest([a, changed]));
  });

  test("covers file blobs", () => {
    const file: PackageManifestItem = {
      kind: "file",
      key: "d".repeat(64),
      path: itemPath("file", "d".repeat(64)),
      sha256: "e".repeat(64),
      blob_path: `files/${"d".repeat(64)}.bin`,
      blob_sha256: "d".repeat(64),
    };
    const otherBlob = { ...file, blob_sha256: "f".repeat(64) };
    expect(contentDigest([file])).not.toBe(contentDigest([otherBlob]));
    expect(contentDigest([file])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stableUuid", () => {
  test("is deterministic and shaped like a name-based uuid", () => {
    const first = stableUuid("tenant", "package", "item");
    expect(first).toBe(stableUuid("tenant", "package", "item"));
    expect(first).toMatch(UUID_V5_SHAPE);
  });

  test("separates parts so concatenation cannot collide", () => {
    expect(stableUuid("ab", "c")).not.toBe(stableUuid("a", "bc"));
    expect(stableUuid("a")).not.toBe(stableUuid("b"));
  });
});

describe("sortPayloads", () => {
  test("orders by kind dependency order then key", () => {
    const sorted = sortPayloads([
      { kind: "workflow" as const, key: "b" },
      { kind: "connector" as const, key: "z@dev" },
      { kind: "workflow" as const, key: "a" },
      { kind: "connector_template" as const, key: "t" },
    ]);
    expect(sorted.map((item) => `${item.kind}:${item.key}`)).toEqual([
      "connector_template:t",
      "connector:z@dev",
      "workflow:a",
      "workflow:b",
    ]);
  });
});

describe("sha256Hex", () => {
  test("hashes strings and bytes identically", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex(new TextEncoder().encode("abc")));
  });
});
