import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PROMPT_CACHE_TTL, toSystemMessages } from "../cache-blocks.ts";

const ENGINE_SRC = join(import.meta.dir, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "tests" || name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function code(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("prompt cache TTL", () => {
  test("the engine's cache TTL is one hour", () => {
    expect(PROMPT_CACHE_TTL).toBe("1h");
  });

  test("a cache hint without an explicit TTL is written with the one-hour TTL", () => {
    const [head] = toSystemMessages(
      { stable: "stable head", volatile: "", token_counts: { stable: 1, volatile: 0 } },
      { enabled: true },
    );
    expect(head?.providerOptions?.anthropic.cacheControl.ttl).toBe("1h");
  });

  test("every TTL literal in engine source is one hour", () => {
    const found: string[] = [];
    for (const file of sourceFiles(ENGINE_SRC)) {
      const text = code(file);
      for (const m of text.matchAll(/\bttl["']?\s*[:=]\s*["'`](\w+)["'`]/g)) {
        found.push(`${relative(ENGINE_SRC, file)}: ${m[1]}`);
      }
      for (const m of text.matchAll(/ephemeral["'`]\s*,\s*ttl\s*:\s*["'`]?([\w.]+)/g)) {
        found.push(`${relative(ENGINE_SRC, file)}: ${m[1]}`);
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(2);
    const notOneHour = found.filter((f) => !/: (1h|opts\.ttl)$/.test(f));
    expect(notOneHour).toEqual([]);
  });

  test("no raw cache_control is set outside the cache-block helper", () => {
    const offenders = sourceFiles(ENGINE_SRC)
      .filter((file) => !file.endsWith(join("runtime", "cache-blocks.ts")))
      .filter((file) => /cache_control\s*:|cacheControl\s*:/.test(code(file)))
      .map((file) => relative(ENGINE_SRC, file));
    expect(offenders).toEqual([]);
  });
});
