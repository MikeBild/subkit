import { expect, test } from "bun:test";
import { workflowJsonDigest } from "./canonical-json.ts";
import {
  assertStorageRequest,
  compileStorageBoundary,
  StorageBoundarySchema,
  StorageScopeSchema,
  storageBaseUrl,
  storageBoundary,
} from "./storage-boundary.ts";
import { RequestStepSchema } from "./types.ts";

const base = "https://store.example.test/bucket/";
const step = RequestStepSchema.parse({
  id: "store",
  kind: "request",
  connector_id: "00000000-0000-4000-8000-000000000001",
  method: "PUT",
  body: "${scope.report.data}",
  s3: {
    key: "${scope.report.key}",
    content_type: "application/json",
    scope: { key_prefix: "reports/daily/", max_bytes: 10 },
  },
});
const boundary = storageBoundary(step, base)!;
const request = {
  method: "PUT",
  url: `${base}reports/daily/2026-01-01.json`,
  headers: { "content-type": "application/json" },
  body: "{}",
};
test("storage endpoint matches path-style and virtual-hosted configuration", () => {
  expect(storageBaseUrl({ bucket: "bucket", endpoint: "https://store.example.test" })).toBe(base);
  expect(
    storageBaseUrl({
      bucket: "bucket",
      endpoint: "https://store.example.test",
      force_path_style: false,
    }),
  ).toBe("https://bucket.store.example.test/");
  expect(
    storageBaseUrl({ bucket: "bucket", endpoint: "https://user:secret@store.example.test" }),
  ).toBeNull();
  expect(storageBaseUrl({ bucket: "bucket", endpoint: "https://${input.host}" })).toBeNull();
});
test("scoped dynamic report keys are bounded at dispatch", () => {
  expect(boundary).not.toBeNull();
  expect(() => assertStorageRequest(boundary, request)).not.toThrow();
  for (const change of [
    { url: `${base}private/report.json` },
    { url: "https://other.example.test/bucket/reports/daily/a.json" },
    { url: `${base}reports/daily/../../private/a.json` },
    { method: "DELETE" },
    { body: "x".repeat(11) },
    { body: { injected: true } },
    { headers: { "x-http-method-override": "DELETE" } },
    { url: `${request.url}?acl` },
    { unsupported_body: true },
  ])
    expect(() => assertStorageRequest(boundary, { ...request, ...change })).toThrow(
      "reviewed folder",
    );
});
test("no root or unresolved prefix can be proposed", () => {
  for (const key_prefix of [
    "/",
    "",
    "../",
    "reports/../",
    "${input.prefix}/",
    "reports%2F/",
    "/reports/",
  ])
    expect(StorageScopeSchema.safeParse({ key_prefix, max_bytes: 10 }).success).toBe(false);
});
test("unsupported storage options never become reusable authority", () => {
  for (const extra of [
    { presign: { expires_in_s: 60 } },
    { multipart: true },
    { metadata: { other: "value" } },
    { range: "bytes=0-10" },
  ]) {
    const changed = RequestStepSchema.parse({ ...step, s3: { ...step.s3, ...extra } });
    expect(storageBoundary(changed, base)).toBeNull();
  }
  expect(storageBoundary(RequestStepSchema.parse({ ...step, method: "DELETE" }), base)).toBeNull();
});
const deleteStep = RequestStepSchema.parse({
  id: "purge",
  kind: "request",
  connector_id: "00000000-0000-4000-8000-000000000001",
  method: "DELETE",
  s3: {
    key: "${item.key}",
    scope: { key_prefix: "reports/daily/", max_bytes: 10, max_deletes: 500 },
  },
});
test("a removal is only bounded once the author declares a ceiling", () => {
  const { max_deletes: _ceiling, ...noCeiling } = deleteStep.s3!.scope!;
  expect(
    storageBoundary(
      RequestStepSchema.parse({ ...deleteStep, s3: { ...deleteStep.s3, scope: noCeiling } }),
      base,
    ),
  ).toBeNull();
  const bounded = storageBoundary(deleteStep, base);
  expect(bounded?.operation).toBe("DELETE");
  expect(bounded?.max_deletes).toBe(500);
  expect(
    storageBoundary(RequestStepSchema.parse({ ...deleteStep, body: "payload" }), base),
  ).toBeNull();
  expect(StorageBoundarySchema.safeParse({ ...bounded, max_deletes: undefined }).success).toBe(
    false,
  );
});
test("a bounded removal cannot leave its reviewed folder", () => {
  const bounded = storageBoundary(deleteStep, base)!;
  const removal = {
    method: "DELETE",
    url: `${base}reports/daily/2026-01-01.json`,
    headers: {},
    body: null,
  };
  expect(() => assertStorageRequest(bounded, removal)).not.toThrow();
  for (const change of [
    { url: `${base}private/report.json` },
    { url: "https://other.example.test/bucket/reports/daily/a.json" },
    { url: `${base}reports/daily/../../private/a.json` },
    { url: `${removal.url}?versionId=abc` },
    { method: "GET" },
    { body: "x" },
    { headers: { "content-type": "application/json" } },
    { unsupported_body: true },
  ])
    expect(() => assertStorageRequest(bounded, { ...removal, ...change })).toThrow(
      "reviewed folder",
    );
});
test("a storage boundary without a ceiling keeps its digest — live grants must not move", () => {
  expect(workflowJsonDigest(boundary)).toBe(
    "1de1f8dfaeb9d1fc33c75f27c0df83d554a3e0383c15e9ddd84d1072d70a708d",
  );
  expect(Object.keys(boundary)).not.toContain("max_deletes");
});
test("LIST cannot change bucket, prefix, page size or operation", () => {
  const list = storageBoundary(
    RequestStepSchema.parse({
      ...step,
      method: "LIST",
      body: undefined,
      s3: { prefix: "${item.prefix}", max_keys: 20, paginate: true, scope: step.s3!.scope },
    }),
    base,
  )!;
  const listRequest = {
    method: "GET",
    url: `${base}?list-type=2&prefix=reports%2Fdaily%2F&max-keys=20`,
    headers: {},
    body: null,
  };
  expect(() => assertStorageRequest(list, listRequest)).not.toThrow();
  for (const query of [
    "list-type=2&prefix=private%2F&max-keys=20",
    "list-type=2&prefix=reports%2Fdaily%2F&max-keys=21",
    "list-type=2&prefix=reports%2Fdaily%2F&max-keys=20&delete=1",
    "list-type=2&prefix=reports%2Fdaily%2F&prefix=private&max-keys=20",
  ])
    expect(() => assertStorageRequest(list, { ...listRequest, url: `${base}?${query}` })).toThrow();
  expect(() =>
    assertStorageRequest(
      { ...list, paginate: false },
      { ...listRequest, url: `${listRequest.url}&continuation-token=next` },
    ),
  ).toThrow();
});

test("a refused boundary names the one thing to change", () => {
  const reasonFor = (change: Record<string, unknown>) =>
    compileStorageBoundary(RequestStepSchema.parse({ ...deleteStep, ...change }), base).refusal;
  expect(reasonFor({ body: { items: ["a"] } })).toBe("delete_with_body");
  expect(reasonFor({ query: { acl: "1" } })).toBe("query_or_headers_present");
  expect(reasonFor({ headers: { "x-test": "1" } })).toBe("query_or_headers_present");
  expect(reasonFor({ s3: { ...deleteStep.s3, scope: undefined } })).toBe("no_scope");
  expect(reasonFor({ s3: { ...deleteStep.s3, range: "bytes=0-1" } })).toBe("unsupported_option");
  expect(compileStorageBoundary(deleteStep, null).refusal).toBe("base_unresolved");
  expect(compileStorageBoundary(deleteStep, base).refusal).toBeUndefined();
});
test("empty query/headers objects and a null body are absent, not present", () => {
  const generated = RequestStepSchema.parse({
    ...deleteStep,
    body: null,
    query: {},
    headers: {},
  });
  expect(compileStorageBoundary(generated, base).boundary?.operation).toBe("DELETE");
});
