import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  type AppCheck,
  appActivationOutcome,
  appBearerProvider,
  appCheckLines,
  appGoneFromList,
  appReadiness,
  appSettingsPatch,
  appUserLabel,
  appUserLastSeen,
  definitionGuardBucket,
  definitionProductId,
  fetchCurrentVersionDag,
  mayEraseAppUsers,
  personApps,
  personEmailText,
  personNameText,
  productEntry,
  productErrors,
  signInDraft,
  signInErrors,
  signInProvider,
  withProduct,
  withProvider,
} from "@/pages/apps-model";
import type { SettingsResponse } from "@/pages/settings-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);
const WORKFLOW = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKFLOW = "22222222-2222-4222-8222-222222222222";

const API_KEY = { protocol: "api_key", id: "api-key", label: "SubKit API key" };
const BROWSER = {
  protocol: "oidc",
  id: "browser",
  label: "Browser",
  issuer_url: "https://login.example.com",
  client_id: "cockpit",
  scopes: "openid email",
  tenant_slug: "default",
  link_by_email: true,
};
const SHOP_BEARER = {
  protocol: "oidc_bearer",
  id: "shop-bearer",
  label: "Shop",
  issuer_url: "https://auth.shop.example.com",
  jwks_uri: "https://auth.shop.example.com/jwks",
  audience: "shop",
  algorithms: ["ES256"],
  product_id: "shop",
  tenant_slug: "default",
  required_claims: [{ path: "role", equals: "authenticated" }],
  reject_anonymous: true,
  clock_tolerance_s: 45,
};
const BLOG_BEARER = {
  ...SHOP_BEARER,
  id: "blog-bearer",
  issuer_url: "https://auth.blog.example.com",
  product_id: "blog",
};

describe("one app's entry changes, every other entry stays", () => {
  const products = {
    blog: {
      execution_environment: "prod",
      assistant_workflow_id: OTHER_WORKFLOW,
      budget_bucket: "b",
    },
    shop: { execution_environment: "dev", assistant_workflow_id: WORKFLOW, budget_bucket: "s" },
    wiki: { execution_environment: "dev", assistant_workflow_id: WORKFLOW, budget_bucket: "w" },
  };

  test("replacing a product keeps the others byte for byte and in place", () => {
    const next = withProduct(products, "shop", { ...products.shop, budget_bucket: "chat" });
    expect(Object.keys(next)).toEqual(["blog", "shop", "wiki"]);
    expect(next.blog).toBe(products.blog);
    expect(next.wiki).toBe(products.wiki);
    expect(next.shop).toEqual({ ...products.shop, budget_bucket: "chat" });
  });

  test("adding a product appends it; removing one drops only that key", () => {
    expect(Object.keys(withProduct(products, "docs", products.shop))).toEqual([
      "blog",
      "shop",
      "wiki",
      "docs",
    ]);
    const removed = withProduct(products, "shop", null);
    expect(removed).toEqual({ blog: products.blog, wiki: products.wiki });
    expect(withProduct(undefined, "shop", products.shop)).toEqual({ shop: products.shop });
  });

  test("a product edit keeps fields this editor does not know", () => {
    const entry = productEntry(
      { ...products.shop, future_field: 7 },
      { execution_environment: "prod", assistant_workflow_id: WORKFLOW, budget_bucket: " chat " },
    );
    expect(entry).toEqual({
      execution_environment: "prod",
      assistant_workflow_id: WORKFLOW,
      budget_bucket: "chat",
      future_field: 7,
    });
  });

  test("replacing a provider by id keeps every other protocol and the order", () => {
    const providers = [API_KEY, SHOP_BEARER, BROWSER, BLOG_BEARER];
    const edited = { ...SHOP_BEARER, id: "shop-token", audience: "shop-api" };
    const next = withProvider(providers, "shop-bearer", edited);
    expect(next).toEqual([API_KEY, edited, BROWSER, BLOG_BEARER]);
    expect(next[0]).toBe(API_KEY);
    expect(next[2]).toBe(BROWSER);
    expect(next[3]).toBe(BLOG_BEARER);
  });

  test("a new provider is appended and a removed one leaves the rest", () => {
    expect(withProvider([API_KEY, BROWSER], null, SHOP_BEARER)).toEqual([
      API_KEY,
      BROWSER,
      SHOP_BEARER,
    ]);
    expect(withProvider([API_KEY, SHOP_BEARER, BROWSER], "shop-bearer", null)).toEqual([
      API_KEY,
      BROWSER,
    ]);
    expect(withProvider([API_KEY], "missing", null)).toEqual([API_KEY]);
  });

  test("the patch builds on the freshly loaded revision and names only the changed values", () => {
    const data: Pick<SettingsResponse, "saved_revision" | "items"> = {
      saved_revision: 12,
      items: [
        {
          path: "products",
          value: products,
          meta: {} as SettingsResponse["items"][number]["meta"],
        },
        {
          path: "auth.providers",
          value: [API_KEY, BROWSER, SHOP_BEARER],
          meta: {} as SettingsResponse["items"][number]["meta"],
        },
      ],
    };
    const patch = appSettingsPatch(data, {
      products: (value) => withProduct(value, "shop", null),
    });
    expect(patch).toEqual({
      expected_revision: 12,
      scope: "global",
      changes: { products: { blog: products.blog, wiki: products.wiki } },
    });
    expect(() => appSettingsPatch({ ...data, saved_revision: null }, {})).toThrow();
  });

  test("an edited sign-in keeps fields the dialog does not show", () => {
    const draft = { ...signInDraft(SHOP_BEARER, "shop"), audience: "shop-api", jwks_uri: "" };
    const provider = signInProvider(SHOP_BEARER, draft, "shop");
    expect(provider.clock_tolerance_s).toBe(45);
    expect(provider).not.toHaveProperty("jwks_uri");
    expect(provider.audience).toBe("shop-api");
    expect(provider.product_id).toBe("shop");
    expect(provider.required_claims).toEqual([{ path: "role", equals: "authenticated" }]);
  });

  test("required claims keep their type", () => {
    const draft = {
      ...signInDraft(null, "shop"),
      required_claims: [
        { path: "app_metadata.tier", type: "number" as const, value: "2" },
        { path: "email_verified", type: "boolean" as const, value: "true" },
        { path: "role", type: "string" as const, value: "member" },
      ],
    };
    expect(signInProvider(null, draft, "shop").required_claims).toEqual([
      { path: "app_metadata.tier", equals: 2 },
      { path: "email_verified", equals: true },
      { path: "role", equals: "member" },
    ]);
    expect(
      signInDraft({ ...SHOP_BEARER, required_claims: [{ path: "n", equals: 3 }] }, "shop"),
    ).toMatchObject({ required_claims: [{ path: "n", type: "number", value: "3" }] });
  });

  test("the app's own bearer provider is found among others", () => {
    expect(appBearerProvider([API_KEY, BROWSER, BLOG_BEARER, SHOP_BEARER], "shop")).toBe(
      SHOP_BEARER,
    );
    expect(appBearerProvider([API_KEY, { ...BROWSER, product_id: "shop" }], "shop")).toBeNull();
  });
});

describe("sign-in and settings are checked before they are saved", () => {
  const valid = signInDraft(SHOP_BEARER, "shop");

  test("a valid edit of the existing provider passes", () => {
    expect(signInErrors("shop", valid, [API_KEY, SHOP_BEARER, BLOG_BEARER], "shop-bearer")).toEqual(
      [],
    );
  });

  test("a taken id, a shared issuer and insecure addresses are refused", () => {
    expect(
      signInErrors(
        "shop",
        { ...valid, id: "blog-bearer" },
        [SHOP_BEARER, BLOG_BEARER],
        "shop-bearer",
      ),
    ).toContain("apps.error.signInIdTaken");
    expect(
      signInErrors(
        "shop",
        { ...valid, issuer_url: BLOG_BEARER.issuer_url },
        [SHOP_BEARER, BLOG_BEARER],
        "shop-bearer",
      ),
    ).toContain("apps.error.issuerTaken");
    expect(
      signInErrors("shop", { ...valid, issuer_url: "http://auth.example.com" }, [], null),
    ).toContain("apps.error.issuer");
    expect(
      signInErrors("shop", { ...valid, issuer_url: "http://localhost:9999" }, [], null),
    ).toEqual([]);
    expect(signInErrors("shop", { ...valid, jwks_uri: "ftp://x" }, [], null)).toContain(
      "apps.error.jwks",
    );
  });

  test("audience, algorithms, claims and the app id follow the engine's rules", () => {
    expect(signInErrors("shop", { ...valid, audience: " " }, [], null)).toContain(
      "apps.error.audience",
    );
    expect(signInErrors("shop", { ...valid, algorithms: [] }, [], null)).toContain(
      "apps.error.algorithms",
    );
    expect(
      signInErrors(
        "shop",
        { ...valid, required_claims: [{ path: "a..b", type: "string", value: "x" }] },
        [],
        null,
      ),
    ).toContain("apps.error.claim");
    expect(
      signInErrors(
        "shop",
        { ...valid, required_claims: [{ path: "tier", type: "number", value: "two" }] },
        [],
        null,
      ),
    ).toContain("apps.error.claim");
    const many = Array.from({ length: 17 }, (_, index) => ({
      path: `c${index}`,
      type: "string" as const,
      value: "x",
    }));
    expect(signInErrors("shop", { ...valid, required_claims: many }, [], null)).toContain(
      "apps.error.claimCount",
    );
    expect(signInErrors("1shop", valid, [], null)).toContain("apps.error.appId");
  });

  test("app settings need an assistant workflow and a bucket", () => {
    expect(
      productErrors("shop", {
        execution_environment: "dev",
        assistant_workflow_id: WORKFLOW,
        budget_bucket: "chat",
      }),
    ).toEqual([]);
    expect(
      productErrors("shop", {
        execution_environment: "dev",
        assistant_workflow_id: "",
        budget_bucket: "",
      }),
    ).toEqual(["apps.error.assistant", "apps.error.bucket"]);
  });
});

describe("people who signed in through an app", () => {
  test("a placeholder address reads as an app user of its provider", () => {
    const user = {
      email: "shop-bearer:2c7c0d4e-0000-4000-8000-000000000000@invalid",
      display_name: null,
      identities: [{ provider_id: "shop-bearer", product_id: "shop", last_seen_at: "2026-01-01" }],
    };
    expect(personEmailText(user, de)).toBe("App-Nutzer · shop-bearer");
    expect(personNameText(user, de)).toBe("App-Nutzer · shop-bearer");
    expect(personNameText(user, de)).not.toContain("2c7c0d4e");
    expect(personNameText({ ...user, display_name: "Lena" }, de)).toBe("Lena");
  });

  test("a placeholder without provider prefix falls back to the identity", () => {
    expect(
      personEmailText(
        { email: "opaque@INVALID", identities: [{ provider_id: "blog-bearer" }] },
        de,
      ),
    ).toBe("App-Nutzer · blog-bearer");
    expect(personEmailText({ email: "opaque@invalid" }, de)).toBe("App-Nutzer");
  });

  test("a real address stays as it is", () => {
    expect(personEmailText({ email: "lena@example.com" }, de)).toBe("lena@example.com");
    expect(personEmailText({ email: "lena@invalid.example.com" }, de)).toBe(
      "lena@invalid.example.com",
    );
  });

  test("apps of a person are distinct, sorted and skip identities without an app", () => {
    expect(
      personApps({
        identities: [
          { product_id: "shop" },
          { product_id: null },
          { product_id: "blog" },
          { product_id: "shop" },
        ],
      }),
    ).toEqual(["blog", "shop"]);
    expect(personApps({})).toEqual([]);
  });
});

describe("only an administrator may erase app users", () => {
  const rights = ["identity:write", "settings:read"];

  test("an administrator with identity and settings rights may erase", () => {
    expect(mayEraseAppUsers({ permissions: rights, principal: { role_name: "admin" } })).toBe(true);
  });

  test("a member with the same rights sees no erase action", () => {
    expect(mayEraseAppUsers({ permissions: rights, principal: { role_name: "member" } })).toBe(
      false,
    );
    expect(mayEraseAppUsers({ permissions: rights, principal: { role_name: null } })).toBe(false);
  });

  test("an administrator without identity write sees no erase action", () => {
    expect(
      mayEraseAppUsers({ permissions: ["settings:read"], principal: { role_name: "admin" } }),
    ).toBe(false);
  });
});

describe("erasing an app user", () => {
  const user = {
    id: "4b1d0000-0000-4000-8000-0000000000aa",
    email: "shop-bearer:4b1d0000@invalid",
    display_name: null,
    identities: [
      { provider_id: "shop-bearer", product_id: "shop", last_seen_at: "2026-10-01T08:00:00.000Z" },
      { provider_id: "shop-bearer", product_id: "shop", last_seen_at: "2026-10-15T08:00:00.000Z" },
      { provider_id: "blog-bearer", product_id: "blog", last_seen_at: "2026-10-16T08:00:00.000Z" },
    ],
  };

  test("last seen counts only the identities of that app", () => {
    expect(appUserLastSeen(user, "shop")).toBe("2026-10-15T08:00:00.000Z");
    expect(appUserLastSeen(user, "blog")).toBe("2026-10-16T08:00:00.000Z");
    expect(appUserLastSeen(user, "other")).toBeNull();
    expect(appUserLastSeen({}, "shop")).toBeNull();
  });

  test("the label names the person and tells same-provider users apart", () => {
    expect(appUserLabel(user, de)).toBe("App-Nutzer · shop-bearer (4b1d0000)");
    expect(appUserLabel({ ...user, display_name: "Lena" }, de)).toBe("Lena (4b1d0000)");
  });
});

describe("activation after a save", () => {
  test("only an active revision counts as applied; anything else is not reported as done", () => {
    expect(appActivationOutcome("active")).toBe("active");
    expect(appActivationOutcome("restart_required")).toBe("restart_required");
    for (const status of ["failed", "preparing", "saved", "unknown"])
      expect(appActivationOutcome(status)).toBe("failed");
  });
});

describe("removed app", () => {
  test("counts an app as gone only when the refreshed list no longer holds it", () => {
    expect(appGoneFromList({ items: [{ id: "helpdesk" }] }, "helpdesk")).toBe(false);
    expect(appGoneFromList({ items: [{ id: "partner" }] }, "helpdesk")).toBe(true);
    expect(appGoneFromList({ items: [] }, "helpdesk")).toBe(true);
    expect(appGoneFromList(undefined, "helpdesk")).toBe(false);
  });
});

describe("readiness", () => {
  test("an app without settings is not set up, whatever the other checks say", () => {
    expect(appReadiness({ configured: false, ready: true })).toBe("not_configured");
    expect(appReadiness({ configured: true, ready: false })).toBe("needs_attention");
    expect(appReadiness({ configured: true, ready: true })).toBe("ready");
  });

  test("every check is named in both languages; a failing one carries its next action", () => {
    const checks: AppCheck[] = [
      "product_configured",
      "sign_in_provider",
      "assistant_workflow",
      "execution_authority",
      "credentials",
      "budget_guard",
    ].map((key, index) => ({
      key: key as AppCheck["key"],
      ok: index % 2 === 0,
      message: `message ${key}`,
      next_action: `do ${key}`,
    }));
    for (const locale of ["en", "de"] as const) {
      const lines = appCheckLines(checks, (key, values) => translate(locale, key, values));
      for (const line of lines) expect(line.label).not.toMatch(/^apps\./);
    }
    const lines = appCheckLines(checks, de);
    expect(lines.map((line) => line.state)).toEqual([
      "ok",
      "needs_attention",
      "ok",
      "needs_attention",
      "ok",
      "needs_attention",
    ]);
    expect(lines[0]?.next).toBeNull();
    expect(lines[1]?.next).toBe("do sign_in_provider");
    expect(lines[1]?.detail).toBe("message sign_in_provider");
  });
});

describe("what a stored definition says about its app", () => {
  const dag = {
    name: "Shop assistant",
    product_id: "shop",
    execution_guards: { caller_daily_limit: { bucket: "chat", limit: 20, tz: "Europe/Berlin" } },
    steps: [],
  };

  const history = (count: number, currentNumber: number) => {
    const versions = Array.from({ length: count }, (_, index) => {
      const number = count - index;
      return {
        id: `v${number}`,
        version: number,
        dag: number === currentNumber ? dag : { ...dag, product_id: "blog" },
      };
    });
    const requests: [number, number][] = [];
    const fetchPage = async (limit: number, offset: number) => {
      requests.push([limit, offset]);
      return { items: versions.slice(offset, offset + limit), total: versions.length };
    };
    return { fetchPage, requests };
  };

  test("product and guard bucket are read from the current version only", async () => {
    const { fetchPage } = history(2, 1);
    const current = await fetchCurrentVersionDag(fetchPage, "v1", 1);
    expect(definitionProductId(current)).toBe("shop");
    expect(definitionGuardBucket(current)).toBe("chat");
    expect(await fetchCurrentVersionDag(fetchPage, null, 1)).toBeNull();
    expect(await fetchCurrentVersionDag(fetchPage, "v9", 9)).toBeNull();
  });

  test("a current version beyond the first page of history is still found without loading it all", async () => {
    const { fetchPage, requests } = history(120, 5);
    const current = await fetchCurrentVersionDag(fetchPage, "v5", 5);
    expect(definitionProductId(current)).toBe("shop");
    expect(requests).toEqual([
      [1, 0],
      [1, 115],
    ]);
  });

  test("version numbers with gaps fall back to scanning the history", async () => {
    const { fetchPage } = history(120, 5);
    const current = await fetchCurrentVersionDag(fetchPage, "v5", 7);
    expect(definitionProductId(current)).toBe("shop");
  });

  test("a definition without product or guard says nothing", () => {
    expect(definitionProductId({ name: "x", steps: [] })).toBeNull();
    expect(definitionGuardBucket({ name: "x", execution_guards: {} })).toBeNull();
    expect(definitionGuardBucket(null)).toBeNull();
  });
});
