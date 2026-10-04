import { describe, expect, test } from "bun:test";
import { __testHooks } from "./authoring-cards.tsx";

const { renderArrayOfObjects, previewLines } = __testHooks;

describe("renderArrayOfObjects · nested title fallback (Bug JJ)", () => {
  test("uses nested project.name when top-level has no title", () => {
    const arr = [
      { project: { id: "p1", name: "Acme" }, resources: [{ id: "r1" }, { id: "r2" }] },
      { project: { id: "p2", name: "subkit" }, resources: [{ id: "r3" }] },
    ];
    const lines = renderArrayOfObjects(arr, 20, 100);
    expect(lines[0]).toMatch(/^1\. Acme/);
    expect(lines[0]).toMatch(/2 resources$/);
    const secondItemLine = lines.find((l) => l.startsWith("2."));
    expect(secondItemLine).toMatch(/^2\. subkit/);
    expect(secondItemLine).toMatch(/1 resources$/);
  });

  test("falls back to last-resort first-string-field on nested object when no title key", () => {
    const arr = [{ meta: { description: "A real description" }, count: 5 }];
    const lines = renderArrayOfObjects(arr, 10, 100);
    expect(lines[0]).toMatch(/^1\. A real description/);
  });

  test("uses top-level name when present (no nested walk needed)", () => {
    const arr = [{ name: "TopLevel", id: "x1" }];
    const lines = renderArrayOfObjects(arr, 10, 100);
    expect(lines[0]).toMatch(/^1\. TopLevel/);
    const bullets = lines.filter((l) => l.startsWith("   • "));
    expect(bullets.find((b) => b.includes("name:"))).toBeUndefined();
  });

  test("does not consume nested title key — it stays visible as a bullet so the operator can see the full record", () => {
    const arr = [{ project: { id: "p1", name: "Acme" }, resources: [{ id: "r1" }] }];
    const lines = renderArrayOfObjects(arr, 10, 100);
    const bullets = lines.filter((l) => l.startsWith("   • "));
    expect(bullets.find((b) => b.includes("project:"))).toBeDefined();
    expect(bullets.find((b) => b.includes("resources:"))).toBeDefined();
  });

  test("falls back to 'item N' only when neither top-level nor nested string title is found", () => {
    const arr = [{ a: 1, b: 2, c: { d: 42 } }];
    const lines = renderArrayOfObjects(arr, 10, 100);
    expect(lines[0]).toMatch(/^1\. item 1/);
  });

  test("count suffix uses nested array's key name (e.g. '4 resources', '2 droplets')", () => {
    const arr = [{ project: { name: "X" }, droplets: [{ id: "d1" }, { id: "d2" }] }];
    const lines = renderArrayOfObjects(arr, 10, 100);
    expect(lines[0]).toMatch(/^1\. X — 2 droplets$/);
  });

  test("previewLines integration end-to-end on a nested array shape", () => {
    const arr = [
      {
        project: { id: "p1", name: "Acme", environment: "Production" },
        resources: [{}, {}, {}, {}],
      },
      { project: { id: "p2", name: "subkit", environment: "Production" }, resources: [{}, {}] },
      { project: { id: "p3", name: "delete-me", environment: "Development" }, resources: [] },
      { project: { id: "p4", name: "acme", environment: null }, resources: [] },
    ];
    const lines = previewLines(arr, 20, 100);
    expect(lines[0]).toMatch(/^1\. Acme — 4 resources/);
    const secondItemLine = lines.find((l) => l.startsWith("2."));
    const thirdItemLine = lines.find((l) => l.startsWith("3."));
    const fourthItemLine = lines.find((l) => l.startsWith("4."));
    expect(secondItemLine).toMatch(/^2\. subkit — 2 resources/);
    expect(thirdItemLine).toMatch(/^3\. delete-me/);
    expect(fourthItemLine).toMatch(/^4\. acme/);
    expect(lines.find((l) => /^\d+\. item /.test(l))).toBeUndefined();
  });
});
