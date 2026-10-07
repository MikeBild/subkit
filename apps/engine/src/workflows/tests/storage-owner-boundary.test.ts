import { describe, expect, test } from "bun:test";
import type { CallerContext } from "../../execution/caller-context.ts";
import type { MaterializedRequest } from "../../execution/prepared-request.ts";
import { assertStorageRequest, type StorageBoundary } from "../storage-boundary.ts";

const base = "https://storage.example.test/storage/s3/bucket/";
const prefix = "products/harmoniqs/principal-a/";

function boundary(operation: StorageBoundary["operation"]): StorageBoundary {
  return {
    base_url: base,
    key_prefix: prefix,
    operation,
    max_bytes: 128,
    max_keys: 10,
    paginate: false,
    content_type: null,
    ...(operation === "DELETE" ? { max_deletes: 1 } : {}),
  };
}

function request(url: string, method: string): MaterializedRequest {
  return {
    url,
    method,
    headers: {},
    body: method === "PUT" ? "value" : null,
  };
}

describe("owner storage folder boundary", () => {
  for (const method of ["GET", "PUT", "HEAD", "DELETE"] as const) {
    test(`${method} permits the owner's object and rejects another owner's object`, () => {
      const scope = boundary(method);
      expect(() =>
        assertStorageRequest(scope, request(`${base}${prefix}songs/document.json`, method)),
      ).not.toThrow();
      for (const key of [
        "products/harmoniqs/principal-b/songs/document.json",
        "products/harmoniqs/principal-a-copy/songs/document.json",
        "products/another-product/principal-a/songs/document.json",
        `${prefix}../principal-b/document.json`,
        `${prefix}%2e%2e/principal-b/document.json`,
        `${prefix}%2e%2e%2fprincipal-b/document.json`,
      ]) {
        expect(() => assertStorageRequest(scope, request(`${base}${key}`, method))).toThrow();
      }
    });
  }

  test("LIST cannot broaden the owner folder or inject a second prefix", () => {
    const scope = boundary("LIST");
    const url = new URL(base);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("max-keys", "10");
    url.searchParams.set("prefix", prefix);
    expect(() => assertStorageRequest(scope, request(url.href, "GET"))).not.toThrow();
    for (const key of ["products/harmoniqs/", "products/harmoniqs/principal-b/"]) {
      url.searchParams.set("prefix", key);
      expect(() => assertStorageRequest(scope, request(url.href, "GET"))).toThrow();
    }
    url.searchParams.set("prefix", prefix);
    url.searchParams.append("prefix", "products/harmoniqs/principal-b/");
    expect(() => assertStorageRequest(scope, request(url.href, "GET"))).toThrow();
  });
});

describe("principal-bound shared storage folder", () => {
  const caller: CallerContext = {
    tenantId: "00000000-0000-4000-8000-000000000041",
    principalId: "00000000-0000-4000-8000-000000000042",
    principalKind: "user",
    provider: "test",
    productId: "harmoniqs",
  };
  const other = "00000000-0000-4000-8000-000000000043";
  const sharedPrefix = "products/harmoniqs/";

  for (const method of ["GET", "HEAD", "PUT", "DELETE"] as const) {
    test(`${method} derives kind and owner segments exclusively from the trusted caller`, () => {
      const scope = { ...boundary(method), key_prefix: sharedPrefix, principal_bound: true };
      const own = request(
        `${base}${sharedPrefix}${caller.principalKind}/${caller.principalId}/song.json`,
        method,
      );
      expect(() => assertStorageRequest(scope, own, caller)).not.toThrow();
      expect(() => assertStorageRequest(scope, own, null)).toThrow();
      for (const key of [
        `${sharedPrefix}user/${other}/song.json`,
        `${sharedPrefix}user/${caller.principalId}-copy/song.json`,
        `${sharedPrefix}shared/${caller.principalId}/song.json`,
        `${sharedPrefix}user/${caller.principalId}/../${other}/song.json`,
        `${sharedPrefix}system_account/${caller.principalId}/song.json`,
        `${sharedPrefix}${caller.principalId}/song.json`,
      ]) {
        expect(() =>
          assertStorageRequest(scope, request(`${base}${key}`, method), caller),
        ).toThrow();
      }
    });
  }

  test("LIST requires the caller folder rather than the shared or sibling prefix", () => {
    const scope = { ...boundary("LIST"), key_prefix: sharedPrefix, principal_bound: true };
    const url = new URL(base);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("max-keys", "10");
    url.searchParams.set("prefix", `${sharedPrefix}user/${caller.principalId}/`);
    expect(() => assertStorageRequest(scope, request(url.href, "GET"), caller)).not.toThrow();
    expect(() => assertStorageRequest(scope, request(url.href, "GET"), null)).toThrow();
    for (const key of [
      sharedPrefix,
      `${sharedPrefix}user/${other}/`,
      `${sharedPrefix}system_account/${caller.principalId}/`,
    ]) {
      url.searchParams.set("prefix", key);
      expect(() => assertStorageRequest(scope, request(url.href, "GET"), caller)).toThrow();
    }
  });

  test("a machine account uses its own realm even when its identifier matches a user", () => {
    const scope = { ...boundary("GET"), key_prefix: sharedPrefix, principal_bound: true };
    const machine = { ...caller, principalKind: "system_account" as const };
    const userObject = request(`${base}${sharedPrefix}user/${caller.principalId}/song.json`, "GET");
    const machineObject = request(
      `${base}${sharedPrefix}system_account/${caller.principalId}/song.json`,
      "GET",
    );
    expect(() => assertStorageRequest(scope, machineObject, machine)).not.toThrow();
    expect(() => assertStorageRequest(scope, userObject, machine)).toThrow();
    expect(() => assertStorageRequest(scope, machineObject, caller)).toThrow();
  });
});
