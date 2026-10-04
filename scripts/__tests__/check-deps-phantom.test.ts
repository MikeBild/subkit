import { describe, expect, test } from "bun:test";
import { aliasPrefixes, detype, importedPackages, pkgNameOf } from "../check-deps-phantom.ts";

describe("pkgNameOf", () => {
  test("ignores relative and absolute specifiers", () => {
    expect(pkgNameOf("./foo", [])).toBeNull();
    expect(pkgNameOf("../bar/baz", [])).toBeNull();
    expect(pkgNameOf("/abs/path", [])).toBeNull();
  });

  test("ignores node/bun builtins and the bun platform module", () => {
    expect(pkgNameOf("node:fs", [])).toBeNull();
    expect(pkgNameOf("fs", [])).toBeNull();
    expect(pkgNameOf("bun:test", [])).toBeNull();
    expect(pkgNameOf("bun", [])).toBeNull();
  });

  test("ignores tsconfig path aliases", () => {
    expect(pkgNameOf("@engine/x/y", ["@engine", "@shared"])).toBeNull();
    expect(pkgNameOf("@shared", ["@engine", "@shared"])).toBeNull();
  });

  test("reduces specifiers to their package name", () => {
    expect(pkgNameOf("react", [])).toBe("react");
    expect(pkgNameOf("cron-parser/lib/x", [])).toBe("cron-parser");
    expect(pkgNameOf("@ai-sdk/provider", [])).toBe("@ai-sdk/provider");
    expect(pkgNameOf("@scope/pkg/sub/path", [])).toBe("@scope/pkg");
  });
});

describe("aliasPrefixes", () => {
  test("extracts the alias prefixes from a tsconfig paths block", () => {
    const tsconfig = `{
      "compilerOptions": {
        "paths": {
          "@engine/*": ["apps/engine/src/*"],
          "@shared/*": ["packages/shared/src/*"]
        }
      }
    }`;
    expect(aliasPrefixes(tsconfig).sort()).toEqual(["@engine", "@shared"]);
  });
});

describe("detype", () => {
  test("rewrites fully type-only import/export keywords to value form", () => {
    expect(detype('import type { X } from "a";')).toContain('import { X } from "a";');
    expect(detype('export type { Y } from "b";')).toContain('export { Y } from "b";');
  });

  test("does not touch inline type modifiers or identifiers", () => {
    const src = 'import { type X, Y } from "a";';
    expect(detype(src)).toBe(src);
  });
});

describe("importedPackages", () => {
  test("collects external imports while ignoring method calls, builtins, and aliases", () => {
    const code = [
      'import React from "react";',
      'import type { Thing } from "@acme/sdk";',
      'import { readFileSync } from "node:fs";',
      'import { helper } from "@shared/util";',
      'import rel from "./local";',
      'const rows = db.from("audit_log");',
      'await import("cron-parser");',
    ].join("\n");
    const got = importedPackages(code, "tsx", ["@shared"]).sort();
    expect(got).toEqual(["@acme/sdk", "cron-parser", "react"]);
  });
});
