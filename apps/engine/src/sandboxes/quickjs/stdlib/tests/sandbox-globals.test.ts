import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runJs } from "../../runtime.ts";
import manifest from "../helpers.manifest.json";
import {
  renderSandboxGlobalsContract,
  SANDBOX_ECMASCRIPT_GLOBALS,
  SANDBOX_SK_FMT_MEMBERS,
  SANDBOX_SK_MEMBERS,
  SANDBOX_STDLIB_GLOBALS,
} from "../sandbox-globals.ts";

const STDLIB_DIR = join(import.meta.dir, "..");

async function liveSurface(): Promise<{ globals: string[]; sk: string[]; fmt: string[] }> {
  const result = await runJs({
    code: "return { globals: Object.getOwnPropertyNames(globalThis), sk: Object.keys(sk), fmt: Object.keys(sk.fmt) };",
    input: null,
    limits: { wall_ms: 5000 },
    clock: null,
  });
  return result.output as { globals: string[]; sk: string[]; fmt: string[] };
}

const sorted = (values: Iterable<string>) => [...values].sort();

function declaredGlobalsInDts(): string[] {
  const dts = readFileSync(join(STDLIB_DIR, "stdlib.d.ts"), "utf8");
  const block = dts.slice(dts.indexOf("declare global {"));
  return [...block.matchAll(/^\s*(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map(
    (m) => m[1] ?? "",
  );
}

describe("sandbox globals contract", () => {
  test("matches the globals the live QuickJS sandbox exposes", async () => {
    const live = await liveSurface();
    const visible = live.globals.filter((name) => !name.startsWith("__"));
    expect(sorted(visible)).toEqual(
      sorted([...SANDBOX_ECMASCRIPT_GLOBALS, ...SANDBOX_STDLIB_GLOBALS]),
    );
    expect(sorted(live.sk)).toEqual(sorted(SANDBOX_SK_MEMBERS));
    expect(sorted(live.fmt)).toEqual(sorted(SANDBOX_SK_FMT_MEMBERS));
  });

  test("covers every global declared in stdlib.d.ts", () => {
    const declared = declaredGlobalsInDts();
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(SANDBOX_STDLIB_GLOBALS).toContain(name);
  });

  test("covers every helper bundle in helpers.manifest.json", () => {
    const bundles = Object.keys(manifest.bundles).filter((name) => name !== "core");
    for (const name of bundles) expect(SANDBOX_SK_MEMBERS).toContain(name);
  });

  test("renders a compact contract block naming the unavailable APIs", () => {
    const block = renderSandboxGlobalsContract().join("\n");
    expect(block).toContain("sk.fmt.number");
    expect(block).toContain("Intl");
    expect(block).toContain("Date.now()");
    expect(block.length).toBeLessThan(2000);
  });
});
