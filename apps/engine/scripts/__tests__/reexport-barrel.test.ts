import { describe, expect, test } from "bun:test";
import {
  isReexportBarrel,
  REEXPORT_BARREL_EXCLUSION,
  reexportBarrelExclusion,
} from "../audit/reexport-barrel.ts";

const barrel = [
  'export * from "./a.ts";',
  'export * as b from "./b.ts";',
  'export { c, d as e } from "./c.ts";',
  'export type { F } from "./f.ts";',
  'export { type G } from "./g.ts";',
].join("\n");

describe("isReexportBarrel", () => {
  test("a file of re-exports only is a barrel", () => {
    expect(isReexportBarrel("x/index.ts", barrel)).toBe(true);
    expect(isReexportBarrel("x/index.tsx", 'export * from "./view.tsx";\n')).toBe(true);
  });

  test("one extra statement makes it wiring that needs a witness", () => {
    for (const extra of [
      "export const answer = 42;",
      "const local = 1;",
      "export function make() { return 1; }",
      'import "./side-effect.ts";',
      'import { a } from "./a.ts";\nexport { a };',
      "export { local };",
      "export default 1;",
      "start();",
    ])
      expect(isReexportBarrel("x/index.ts", `${barrel}\n${extra}\n`)).toBe(false);
  });

  test("an empty or unparsable file is not a barrel", () => {
    expect(isReexportBarrel("x/index.ts", "")).toBe(false);
    expect(isReexportBarrel("x/index.ts", 'export * from "./a.ts"\nexport {')).toBe(false);
  });
});

describe("reexportBarrelExclusion", () => {
  test("names the structural reason only for a barrel", () => {
    expect(reexportBarrelExclusion("x/index.ts", barrel)).toBe(REEXPORT_BARREL_EXCLUSION);
    expect(reexportBarrelExclusion("x/index.ts", "export const a = 1;")).toBeUndefined();
    expect(reexportBarrelExclusion("x/index.ts", null)).toBeUndefined();
  });
});
