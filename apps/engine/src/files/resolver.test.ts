import { describe, expect, test } from "bun:test";
import { FileNotFoundError, type ResolvedFile, storageKey, walkAndResolve } from "./resolver.ts";

describe("storageKey", () => {
  test("strips 'local://' prefix", () => {
    expect(storageKey("local://tenant/2024/01/01/uuid")).toBe("tenant/2024/01/01/uuid");
  });

  test("strips 'local://' and drops query params", () => {
    expect(storageKey("local://key/path?expires_at=1234567890")).toBe("key/path");
  });

  test("strips 's3://<bucket>/' and returns key", () => {
    expect(storageKey("s3://my-bucket/tenant/2024/01/01/uuid")).toBe("tenant/2024/01/01/uuid");
  });

  test("strips 's3://<bucket>' with no trailing slash", () => {
    expect(storageKey("s3://my-bucket/key")).toBe("key");
  });

  test("strips 'memory://' prefix", () => {
    expect(storageKey("memory://some-key")).toBe("some-key");
  });

  test("returns bare key for unknown scheme", () => {
    expect(storageKey("bare-key")).toBe("bare-key");
  });
});

describe("FileNotFoundError", () => {
  test("has code='file_not_found'", () => {
    const err = new FileNotFoundError("fid_abc");
    expect(err.code).toBe("file_not_found");
  });

  test("is an instance of Error", () => {
    expect(new FileNotFoundError("x")).toBeInstanceOf(Error);
  });

  test("message includes the fid", () => {
    expect(new FileNotFoundError("fid_test").message).toContain("fid_test");
  });
});

function makeResolvedFile(id = "uuid-1"): ResolvedFile {
  return {
    id,
    filename: "file.pdf",
    content_type: "application/pdf",
    size_bytes: 512,
    async openRead() {
      return (async function* () {})();
    },
  };
}

describe("walkAndResolve", () => {
  const VALID_FID = "fid_11111111-2222-4333-8444-555555555555";
  const VALID_FID2 = "fid_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  const stubDb = {} as never;

  test("passes non-ref primitives through unchanged", async () => {
    const c = new Map<string, ResolvedFile>();
    expect(await walkAndResolve("hello", { db: stubDb, tenant_id: "t" }, c)).toBe("hello");
    expect(await walkAndResolve(42, { db: stubDb, tenant_id: "t" }, c)).toBe(42);
    expect(await walkAndResolve(null, { db: stubDb, tenant_id: "t" }, c)).toBeNull();
  });

  test("passes a plain object without $file through unchanged", async () => {
    const c = new Map<string, ResolvedFile>();
    const obj = { key: "value", num: 1 };
    const result = await walkAndResolve(obj, { db: stubDb, tenant_id: "t" }, c);
    expect(result).toEqual(obj);
  });

  test("resolves a $file ref from the cache (no DB hit)", async () => {
    const c = new Map<string, ResolvedFile>();
    const resolved = makeResolvedFile();
    c.set(VALID_FID, resolved);
    const result = (await walkAndResolve(
      { $file: VALID_FID },
      { db: stubDb, tenant_id: "t" },
      c,
    )) as unknown;
    expect(result).toBe(resolved);
  });

  test("second resolution of the same fid comes from cache (per-call dedup)", async () => {
    const c = new Map<string, ResolvedFile>();
    const resolved = makeResolvedFile();
    c.set(VALID_FID, resolved);
    const r1 = (await walkAndResolve(
      { $file: VALID_FID },
      { db: stubDb, tenant_id: "t" },
      c,
    )) as unknown;
    const r2 = (await walkAndResolve(
      { $file: VALID_FID },
      { db: stubDb, tenant_id: "t" },
      c,
    )) as unknown;
    expect(r1).toBe(r2);
  });

  test("walks an array and resolves every $file leaf", async () => {
    const c = new Map<string, ResolvedFile>();
    const r1 = makeResolvedFile("uuid-1");
    const r2 = makeResolvedFile("uuid-2");
    c.set(VALID_FID, r1);
    c.set(VALID_FID2, r2);
    const result = await walkAndResolve(
      [{ $file: VALID_FID }, "text", { $file: VALID_FID2 }],
      { db: stubDb, tenant_id: "t" },
      c,
    );
    expect((result as unknown[])[0]).toBe(r1);
    expect((result as unknown[])[1]).toBe("text");
    expect((result as unknown[])[2]).toBe(r2);
  });

  test("walks a deeply nested object { a: { b: [{ $file }] } }", async () => {
    const c = new Map<string, ResolvedFile>();
    const resolved = makeResolvedFile();
    c.set(VALID_FID, resolved);
    const input = { a: { b: [{ $file: VALID_FID }] } };
    const result = (await walkAndResolve(input, { db: stubDb, tenant_id: "t" }, c)) as {
      a: { b: unknown[] };
    };
    expect(result.a.b[0]).toBe(resolved);
  });

  test("mixed JSON with no refs returns the same shape", async () => {
    const c = new Map<string, ResolvedFile>();
    const input = { x: [1, 2, { y: "z" }], flag: true };
    const result = await walkAndResolve(input, { db: stubDb, tenant_id: "t" }, c);
    expect(result).toEqual(input);
  });

  test("unknown fid (not in cache, stubDb throws) propagates FileNotFoundError", async () => {
    const c = new Map<string, ResolvedFile>();
    const throwingDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    } as never;
    await expect(
      walkAndResolve({ $file: VALID_FID }, { db: throwingDb, tenant_id: "t" }, c),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  test("cross-tenant fid (different tenant_id) throws FileNotFoundError", async () => {
    const c = new Map<string, ResolvedFile>();
    const crossTenantDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    } as never;
    await expect(
      walkAndResolve({ $file: VALID_FID }, { db: crossTenantDb, tenant_id: "tenant-b" }, c),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });
});
