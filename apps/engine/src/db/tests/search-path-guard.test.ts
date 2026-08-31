// The boot guard that refuses to serve from the wrong PostgreSQL schema.
//
// The engine no longer sends `-c search_path=subkit,pg_catalog,public` as a
// connection startup option, because a pooler in transaction mode rejects
// startup parameters outright (SQLSTATE 08P01) and the engine cannot boot
// behind one. The runtime path is a role default now.
//
// The trade has a sharp edge worth pinning down: without the role default the
// path falls back to `"$user", public`, where an unqualified table name
// resolves against whatever pre-isolation objects survive in `public` — the
// query SUCCEEDS and returns the wrong rows. An engine executing workflows
// against a stale schema is worse than one that is down, so the guard aborts.
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
      /ALTER ROLE <role> SET search_path = subkit, pg_catalog, public;/,
    );
  });
});
