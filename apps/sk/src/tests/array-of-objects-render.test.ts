import { describe, expect, test } from "bun:test";
import { __testHooks } from "../repl/authoring-cards.tsx";

const { previewLines } = __testHooks;

describe("array-of-objects renderer (chat surface)", () => {
  test("renders DigitalOcean projects shape with title + bullets", () => {
    const lines = previewLines([
      {
        project_id: "d6742174",
        project_name: "Acme",
        resources: [{ urn: "do:domain:acme.example.com" }, { urn: "do:domain:octo-demo.example" }],
      },
      {
        project_id: "11dde76a",
        project_name: "subkit",
        resources: [{ urn: "do:droplet:123456789" }, { urn: "do:domain:example.com" }],
      },
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("Acme");
    expect(joined).toContain("subkit");
    expect(joined).toMatch(/resources: <2 items>/);
    expect(joined).not.toContain('"...":"..."');
  });

  test("falls back to JSON for non-array-of-objects (e.g. a single object)", () => {
    const lines = previewLines({ ok: true, count: 4 });
    const joined = lines.join("\n");
    expect(joined).toContain('"ok": true');
    expect(joined).toContain('"count": 4');
  });

  test("empty array renders as []", () => {
    const lines = previewLines([]);
    expect(lines.join("\n")).toContain("[]");
  });

  test("array of primitives falls back to JSON", () => {
    const lines = previewLines([1, 2, 3]);
    const joined = lines.join("\n");
    expect(joined).toContain("1");
    expect(joined).toContain("2");
  });

  test("truncates large arrays with item count footer", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      id: `item-${i}`,
      label: `Item ${i}`,
    }));
    const lines = previewLines(big, 20);
    expect(lines.length).toBeLessThanOrEqual(21);
    expect(lines.join("\n")).toContain("50 items total");
  });

  test("nested arrays show item count, not nested JSON", () => {
    const lines = previewLines([
      {
        name: "Project A",
        members: [{ id: 1 }, { id: 2 }, { id: 3 }],
      },
    ]);
    const joined = lines.join("\n");
    expect(joined).toMatch(/members: <3 items>/);
  });

  test("primitive arrays render inline up to 3 items", () => {
    const lines = previewLines([{ name: "tagged", tags: ["a", "b", "c", "d"] }]);
    const joined = lines.join("\n");
    expect(joined).toContain("a, b, c");
    expect(joined).toMatch(/\+1/);
  });
});
