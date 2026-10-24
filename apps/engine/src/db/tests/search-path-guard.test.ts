import { describe, expect, test } from "bun:test";
import { assertSearchPath, EXPECTED_SCHEMA } from "../client.ts";

const poolReturning = (schema: string | null) => ({
  query: async () => ({ rows: [{ schema }] }),
});

describe("assertSearchPath", () => {
  test("resolves when the connection lands in the product schema", async () => {
    await expect(assertSearchPath(poolReturning(EXPECTED_SCHEMA))).resolves.toBeUndefined();
  });

  test('aborts on the "$user", public fallback rather than reading pre-isolation objects', async () => {
    await expect(assertSearchPath(poolReturning("public"))).rejects.toThrow(/resolves to public/);
  });

  test("aborts when a foreign schema owns the resolved name", async () => {
    await expect(assertSearchPath(poolReturning("some_other_schema"))).rejects.toThrow(
      /instead of subkit/,
    );
  });

  test("aborts when the search path resolves to no schema at all", async () => {
    await expect(assertSearchPath({ query: async () => ({ rows: [] }) })).rejects.toThrow(
      /no schema/,
    );
  });

  test("names the remedy so an operator can act on the message alone", async () => {
    await expect(assertSearchPath(poolReturning("public"))).rejects.toThrow(
      /sets search_path on every connection, so check that schema subkit exists/,
    );
  });
});
