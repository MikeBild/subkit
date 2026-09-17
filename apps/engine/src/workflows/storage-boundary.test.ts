import { expect, test } from "bun:test";
import {
  assertStorageRequest,
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
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
  body: "${scope.report.data}",
  s3: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
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
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
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
test("LIST cannot change bucket, prefix, page size or operation", () => {
  const list = storageBoundary(
    RequestStepSchema.parse({
      ...step,
      method: "LIST",
      body: undefined,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
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
