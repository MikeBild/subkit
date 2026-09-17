import { expect, test } from "bun:test";
import { isDocumentedReadOperation } from "../steps/request/read-operations.ts";

const request = {
  method: "POST",
  url: "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
  headers: {},
  body: { metrics: [{ name: "activeUsers" }] },
};
test("documented read POST identity is checked against the final request", () => {
  expect(isDocumentedReadOperation(request)).toBe(true);
  for (const url of [
    "https://other.example.test/v1beta/properties/123:runReport",
    "https://analyticsdata.googleapis.com.evil.test/v1beta/properties/123:runReport",
    "http://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
    `${request.url}?method=delete`,
    `${request.url}#extra`,
    `${request.url}/other`,
    request.url.replace(":runReport", ":delete"),
    request.url.replace("123", "%31%32%33"),
    request.url.replace("https://", "https://user@"),
  ])
    expect(isDocumentedReadOperation({ ...request, url })).toBe(false);
  expect(isDocumentedReadOperation({ ...request, method: "DELETE" })).toBe(false);
  expect(isDocumentedReadOperation({ ...request, unsupported_body: true })).toBe(false);
  expect(
    isDocumentedReadOperation({ ...request, headers: { "X-HTTP-Method-Override": "DELETE" } }),
  ).toBe(false);
  expect(isDocumentedReadOperation(undefined)).toBe(false);
});
