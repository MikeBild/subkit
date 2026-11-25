import { expect, test } from "bun:test";
import { resolveUrl } from "../../connectors/drivers/resolve-url.ts";
import { getBuiltinTemplate, loadBuiltinReadOperations } from "../../connectors/templates.ts";
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
  expect(isDocumentedReadOperation({ ...request, body: [] })).toBe(false);
  expect(
    isDocumentedReadOperation({ ...request, headers: { "X-HTTP-Method-Override": "DELETE" } }),
  ).toBe(false);
  expect(isDocumentedReadOperation(undefined)).toBe(false);
});

test("read POST exceptions come from built-in template metadata, whatever the connector binding", () => {
  expect(getBuiltinTemplate("google-analytics")?.read_operations).toEqual([
    {
      method: "POST",
      origin: "https://analyticsdata.googleapis.com",
      path_pattern: "^/v1beta/properties/[1-9][0-9]*:runReport$",
    },
  ]);
  const analytics = getBuiltinTemplate("google-analytics")?.read_operations[0];
  if (!analytics) throw new Error("expected a template read operation");
  expect(loadBuiltinReadOperations()).toContainEqual(analytics);
  expect(isDocumentedReadOperation(request)).toBe(true);
  expect(
    isDocumentedReadOperation({
      ...request,
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      body: { raw: "x" },
    }),
  ).toBe(false);
});

test("every built-in read operation is a POST anchored to a bare https origin", () => {
  for (const operation of loadBuiltinReadOperations()) {
    expect(operation.method).toBe("POST");
    expect(new URL(operation.origin).origin).toBe(operation.origin);
    expect(operation.path_pattern.startsWith("^")).toBe(true);
    expect(operation.path_pattern.endsWith("$")).toBe(true);
  }
});

test("the scheduled HubSpot deal sweep is a documented read POST", () => {
  const hubspot = getBuiltinTemplate("hubspot")!;
  const recipe = hubspot.recipes.find(
    (recipe) => recipe.slug === "postmortem-due-in-n-days-via-state",
  )!;
  const step = recipe.workflow.steps.find((step) => step.id === "deals_due") as {
    method: string;
    path: string;
    connector_id: string;
    headers: Record<string, string>;
    body: unknown;
  };
  expect(recipe.required_connectors).toContainEqual({
    placeholder: step.connector_id,
    template: "hubspot",
  });
  const search = {
    method: step.method,
    url: resolveUrl(hubspot.base_url, step.path).href,
    headers: step.headers,
    body: step.body,
  };
  expect(search.method).toBe("POST");
  expect(isDocumentedReadOperation(search)).toBe(true);
  for (const url of [
    "https://api.hubapi.com/crm/v3/objects/deals",
    "https://api.hubapi.com/crm/v3/objects/deals/batch/update",
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    "https://other.example.test/crm/v3/objects/deals/search",
    `${search.url}/other`,
    `${search.url}?method=delete`,
  ])
    expect(isDocumentedReadOperation({ ...search, url })).toBe(false);
});
