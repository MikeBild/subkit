import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  describeGate,
  EMPTY_GATE,
  type GateFile,
  gateBlocks,
  gateStatus,
  liveFingerprint,
  offlineFingerprint,
  parseGate,
  promptFingerprint,
  recordProofs,
  renderGate,
} from "../gate.ts";

const hash = (c: string) => c.repeat(64);

describe("fingerprints", () => {
  test("key order and formatting do not change a fixture fingerprint", () => {
    const a = offlineFingerprint({ name: "x", input: { b: 1, a: 2 } }, "export const v = 1;");
    const b = offlineFingerprint(
      JSON.parse('{\n  "input": { "a": 2, "b": 1 },\n  "name": "x"\n}'),
      "export const v = 1;",
    );
    expect(a).toBe(b);
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: undefined })).toBe('{"b":[{"c":2,"d":1}]}');
  });

  test("a fixture or its validator changing changes the fingerprint", () => {
    const base = offlineFingerprint({ name: "x", input: 1 }, "v1");
    expect(offlineFingerprint({ name: "x", input: 2 }, "v1")).not.toBe(base);
    expect(offlineFingerprint({ name: "x", input: 1 }, "v2")).not.toBe(base);
  });

  test("a live case changes with its spec and with the prompt", () => {
    const prompt = promptFingerprint([
      { path: "b.ts", content: "B" },
      { path: "a.ts", content: "A" },
    ]);
    expect(prompt).toBe(
      promptFingerprint([
        { path: "a.ts", content: "A" },
        { path: "b.ts", content: "B" },
      ]),
    );
    const spec = { slug: "s", goal: "do it" };
    const base = liveFingerprint(spec, prompt);
    expect(liveFingerprint({ ...spec, goal: "do it now" }, prompt)).not.toBe(base);
    expect(liveFingerprint(spec, promptFingerprint([{ path: "a.ts", content: "A2" }]))).not.toBe(
      base,
    );
  });

  test("an offline and a live case with the same content never share a fingerprint", () => {
    expect(offlineFingerprint({ a: 1 }, "")).not.toBe(liveFingerprint({ a: 1 }, ""));
  });
});

describe("gateStatus", () => {
  const proofs = {
    same: { hash: hash("a"), proven_at: "2026-11-20" },
    edited: { hash: hash("b"), proven_at: "2026-11-20" },
    gone: { hash: hash("c"), proven_at: "2026-11-20" },
  };

  test("reports changed, removed and unproven cases", () => {
    expect(gateStatus(proofs, { same: hash("a"), edited: hash("9"), fresh: hash("d") })).toEqual({
      changed: ["edited"],
      removed: ["gone"],
      unproven: ["fresh"],
    });
  });

  test("a case changed after its proof or a proof without a case blocks; an unproven case does not", () => {
    expect(gateBlocks({ changed: ["x"], removed: [], unproven: [] })).toBe(true);
    expect(gateBlocks({ changed: [], removed: ["x"], unproven: [] })).toBe(true);
    expect(gateBlocks({ changed: [], removed: [], unproven: ["x"] })).toBe(false);
  });

  test("names the command that re-proves each kind", () => {
    expect(
      describeGate([
        { kind: "offline", status: { changed: ["f"], removed: [], unproven: [] } },
        { kind: "live", status: { changed: [], removed: ["s"], unproven: ["u"] } },
      ]),
    ).toEqual([
      "offline f: changed after its last proven run — re-prove with bun run eval baseline",
      "live s: proven case no longer exists — prune with bun run eval live",
    ]);
  });
});

describe("recordProofs", () => {
  const gate: GateFile = {
    offline: {
      kept: { hash: hash("a"), proven_at: "2026-11-01" },
      stale: { hash: hash("b"), proven_at: "2026-11-01" },
      gone: { hash: hash("c"), proven_at: "2026-11-01" },
    },
    live: { slug: { hash: hash("e"), proven_at: "2026-11-01" } },
  };

  test("only a passing case gets a proof, an unchanged proof keeps its date, removed cases are pruned", () => {
    const next = recordProofs(
      gate,
      "offline",
      { kept: hash("a"), stale: hash("9"), failing: hash("f"), fresh: hash("d") },
      new Set(["kept", "fresh"]),
      "2026-11-22",
    );
    expect(next.offline).toEqual({
      kept: { hash: hash("a"), proven_at: "2026-11-01" },
      stale: { hash: hash("b"), proven_at: "2026-11-01" },
      fresh: { hash: hash("d"), proven_at: "2026-11-22" },
    });
    expect(next.live).toBe(gate.live);
  });

  test("a changed case that passes again is proven with the new fingerprint", () => {
    const next = recordProofs(gate, "live", { slug: hash("7") }, new Set(["slug"]), "2026-11-22");
    expect(next.live.slug).toEqual({ hash: hash("7"), proven_at: "2026-11-22" });
  });
});

describe("gate file", () => {
  test("round-trips sorted and rejects a malformed proof", () => {
    const gate: GateFile = {
      offline: {
        z: { hash: hash("1"), proven_at: "2026-11-22" },
        a: { hash: hash("2"), proven_at: "2026-11-22" },
      },
      live: {},
    };
    const raw = renderGate(gate);
    expect(Object.keys(parseGate(raw).offline)).toEqual(["a", "z"]);
    expect(parseGate(null)).toEqual(EMPTY_GATE);
    expect(() =>
      parseGate('{"offline":{"a":{"hash":"short","proven_at":"x"}},"live":{}}'),
    ).toThrow();
  });
});
