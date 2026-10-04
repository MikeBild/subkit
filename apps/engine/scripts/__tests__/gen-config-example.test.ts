import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { listConfigLeaves } from "../../src/config/walk.ts";

const SCRIPT = join(import.meta.dir, "..", "gen-config-example.ts");

function runOnce(): string {
  const result = spawnSync("bun", ["run", SCRIPT], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

function readDeep(source: unknown, leafPath: string[]): unknown {
  let cursor: unknown = source;
  for (const seg of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function expectCredentialFieldsEmpty(source: unknown, path: string): void {
  if (Array.isArray(source)) {
    source.forEach((value, index) => {
      expectCredentialFieldsEmpty(value, `${path}[${index}]`);
    });
    return;
  }
  if (typeof source !== "object" || source === null) return;
  for (const [key, value] of Object.entries(source)) {
    const fieldPath = `${path}.${key}`;
    if (/(?:secret|password|token|credential|private[_-]?key)$/i.test(key)) {
      expect(value, `${fieldPath} must default to empty string`).toBe("");
      continue;
    }
    expectCredentialFieldsEmpty(value, fieldPath);
  }
}

describe("gen-config-example", () => {
  test("output is byte-stable across two runs", () => {
    const a = runOnce();
    const b = runOnce();
    expect(a).toBe(b);
  });

  test("every secret leaf renders without credential material", () => {
    const out = runOnce();
    const parsed = JSON.parse(out) as unknown;
    const secrets = listConfigLeaves().filter((l) => l.meta.secret);
    expect(secrets.length).toBeGreaterThan(5);
    for (const leaf of secrets) {
      const value = readDeep(parsed, leaf.path);
      if (leaf.path.join(".") === "database.url") {
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
        continue;
      }
      expect(value, `${leaf.path.join(".")} must default to empty string`).toBe("");
    }
    const authProviders = readDeep(parsed, ["auth", "providers"]);
    expect(Array.isArray(authProviders)).toBe(true);
    expectCredentialFieldsEmpty(authProviders, "auth.providers");
  });
});
