import { describe, expect, test } from "bun:test";
import { diffAppBoundary } from "./app-boundary-audit.ts";

const apiKey = { protocol: "api_key", id: "api-key", label: "SubKit API key" };
const bearer = {
  protocol: "oidc_bearer",
  id: "testapp-bearer",
  label: "TE-Kit",
  issuer_url: "https://issuer.example.test",
  audience: "authenticated",
  product_id: "testapp",
  required_claims: [],
};
const browser = {
  protocol: "oidc",
  id: "browser",
  label: "Browser",
  issuer_url: "https://browser.example.test",
  client_id: "client",
};
const product = {
  execution_environment: "prod",
  assistant_workflow_id: "00000000-0000-4000-8000-0000000000a1",
  budget_bucket: "brain",
};

function doc(providers: unknown[], products: Record<string, unknown> = {}) {
  return { auth: { providers }, products };
}

describe("diffAppBoundary", () => {
  test("identical documents produce no change, even when one side omits schema defaults", () => {
    const withDefaults = {
      ...bearer,
      algorithms: ["ES256"],
      tenant_slug: "default",
      reject_anonymous: true,
      clock_tolerance_s: 30,
    };
    expect(diffAppBoundary(doc([apiKey, bearer]), doc([apiKey, withDefaults]))).toEqual([]);
  });

  test("adding and removing providers are reported by id with protocol and issuer", () => {
    const changes = diffAppBoundary(doc([apiKey, browser]), doc([apiKey, bearer]));
    expect(changes).toEqual([
      {
        action: "auth_provider.added",
        provider_id: "testapp-bearer",
        protocol: "oidc_bearer",
        issuer_url: "https://issuer.example.test",
        product_id: "testapp",
        tenant_slug: "default",
        changed_fields: [],
      },
      {
        action: "auth_provider.removed",
        provider_id: "browser",
        protocol: "oidc",
        issuer_url: "https://browser.example.test",
        product_id: null,
        tenant_slug: "default",
        changed_fields: [],
      },
    ]);
  });

  test("a changed sign-in boundary names the fields, never their values", () => {
    const changes = diffAppBoundary(
      doc([apiKey, bearer]),
      doc([
        apiKey,
        { ...bearer, audience: "secret-audience", required_claims: [{ path: "a", equals: 1 }] },
      ]),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        action: "auth_provider.changed",
        provider_id: "testapp-bearer",
        changed_fields: ["audience", "required_claims"],
      }),
    ]);
    expect(JSON.stringify(changes)).not.toContain("secret-audience");
  });

  test("reordering is detected among providers present on both sides", () => {
    const changes = diffAppBoundary(doc([apiKey, bearer, browser]), doc([browser, apiKey]));
    expect(changes).toEqual([
      expect.objectContaining({ action: "auth_provider.removed", provider_id: "testapp-bearer" }),
      {
        action: "auth_provider.reordered",
        order_before: ["api-key", "browser"],
        order_after: ["browser", "api-key"],
      },
    ]);
  });

  test("a removed provider alone does not count as a reorder", () => {
    const changes = diffAppBoundary(doc([apiKey, bearer, browser]), doc([apiKey, browser]));
    expect(changes.map((change) => change.action)).toEqual(["auth_provider.removed"]);
  });

  test("products are matched by key and report added, changed and removed", () => {
    const changes = diffAppBoundary(
      doc([apiKey], { testapp: product, oldkit: product }),
      doc([apiKey], { testapp: { ...product, budget_bucket: "chat" }, newkit: product }),
    );
    expect(changes).toEqual([
      { action: "product.added", product_id: "newkit", changed_fields: [] },
      { action: "product.changed", product_id: "testapp", changed_fields: ["budget_bucket"] },
      { action: "product.removed", product_id: "oldkit", changed_fields: [] },
    ]);
  });

  test("documents without auth or products sections diff as empty", () => {
    expect(diffAppBoundary({}, {})).toEqual([]);
  });
});
