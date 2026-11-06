import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DriverEnum } from "../types.ts";
import { lookupDriver, requestDriverKind } from "./port.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

describe("requestDriverKind", () => {
  test("a graphql block or graphql connector selects graphql first", () => {
    expect(requestDriverKind("graphql", {})).toBe("graphql");
    expect(requestDriverKind("http", { graphql: {} })).toBe("graphql");
    expect(requestDriverKind("mcp", { graphql: {} })).toBe("graphql");
    expect(requestDriverKind("graphql", { mcp: {} })).toBe("graphql");
  });

  test("an mcp block or mcp connector selects mcp", () => {
    expect(requestDriverKind("mcp", {})).toBe("mcp");
    expect(requestDriverKind("http", { mcp: {} })).toBe("mcp");
    expect(requestDriverKind("s3", { mcp: {} })).toBe("mcp");
  });

  test("otherwise the connector driver decides", () => {
    expect(requestDriverKind("s3", {})).toBe("s3");
    expect(requestDriverKind("postgres", {})).toBe("postgres");
    expect(requestDriverKind("http", {})).toBe("http");
    expect(requestDriverKind("ftp", {})).toBe("ftp");
  });

  test("property: without declared blocks the driver passes through unless graphql or mcp", () => {
    fc.assert(
      fc.property(fc.string(), (driver) => {
        expect(requestDriverKind(driver, {})).toBe(driver);
      }),
      FC,
    );
  });
});

describe("lookupDriver", () => {
  const registry = Object.fromEntries(
    DriverEnum.options.map((kind) => [kind, { kind }]),
  ) as unknown as Parameters<typeof lookupDriver>[0];

  test("finds every registered driver kind", () => {
    for (const kind of DriverEnum.options) expect(lookupDriver(registry, kind)?.kind).toBe(kind);
  });

  test("returns null for unknown and inherited keys", () => {
    expect(lookupDriver(registry, "ftp")).toBeNull();
    expect(lookupDriver(registry, "toString")).toBeNull();
  });
});
