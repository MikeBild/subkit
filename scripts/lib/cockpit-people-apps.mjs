const SHOP_WORKFLOW = "018f4b4a-6d33-7b3a-9c2d-0000000000c1";
const BLOG_WORKFLOW = "018f4b4a-6d33-7b3a-9c2d-0000000000c2";
const SHOP_USER = "018f4b4a-6d33-7b3a-9c2d-0000000000c3";

const API_KEY = { protocol: "api_key", id: "api-key", label: "SubKit API key" };
const BROWSER = {
  protocol: "oidc",
  id: "example-sso",
  label: "Example SSO",
  issuer_url: "https://auth.example.com",
  client_id: "cockpit",
  scopes: "openid email profile",
  tenant_slug: "default",
};
const SHOP_BEARER = {
  protocol: "oidc_bearer",
  id: "shop-bearer",
  label: "Shop",
  issuer_url: "https://auth.shop.example.com",
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
  label: "Blog",
  issuer_url: "https://auth.blog.example.com",
  audience: "blog",
  product_id: "blog",
};
const SHOP = {
  execution_environment: "prod",
  assistant_workflow_id: SHOP_WORKFLOW,
  budget_bucket: "chat",
};
const BLOG = {
  execution_environment: "dev",
  assistant_workflow_id: BLOG_WORKFLOW,
  budget_bucket: "blog",
};

function require(condition, message) {
  if (!condition) throw new Error(`functional/people-apps: ${message}`);
}

function same(actual, expected, message) {
  require(JSON.stringify(actual) ===
    JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function settingsResponse(state) {
  const meta = (kind) => ({
    source: "global",
    scope: "global",
    sensitive: false,
    requiresRestart: false,
    kind,
  });
  return {
    saved_revision: state.revision,
    active_revision: state.revision,
    activation_status: "active",
    pending_restart_fields: [],
    items: [
      { path: "auth.providers", value: state.providers, meta: meta("json") },
      { path: "products", value: state.products, meta: meta("json") },
    ],
    diagnostics: { pending_restart_keys: [], override_keys: [] },
  };
}

function summary(id, product, erased = false) {
  const shopUsers = id === "shop" && !erased;
  return {
    id,
    configured: Boolean(product),
    ready: id === "blog",
    settings: product
      ? {
          execution_environment: product.execution_environment,
          budget_bucket: product.budget_bucket,
          assistant_workflow: {
            id: product.assistant_workflow_id,
            name: id === "shop" ? "Shop assistant" : "Blog assistant",
            slug: `${id}-assistant`,
          },
          daily_limit: {
            bucket: product.budget_bucket,
            limit_per_caller: 20,
            unit: "conversation_id",
            tz: "Europe/Berlin",
          },
        }
      : null,
    sign_in_count: 1,
    workflow_count: 1,
    users: {
      count: shopUsers ? 1 : 0,
      last_seen_at: shopUsers ? "2026-10-15T08:00:00.000Z" : null,
    },
    failing_checks: id === "shop" ? ["execution_authority"] : [],
  };
}

function view(id, product, erased = false) {
  const { failing_checks: _failing, ...rest } = summary(id, product, erased);
  return {
    ...rest,
    sign_in: [id === "shop" ? SHOP_BEARER : BLOG_BEARER].map((provider) => ({
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      issuer_url: provider.issuer_url,
      tenant_slug: provider.tenant_slug,
      audience: provider.audience,
      algorithms: provider.algorithms,
      required_claims: provider.required_claims,
      reject_anonymous: provider.reject_anonymous,
    })),
    workflows: [
      {
        id: product?.assistant_workflow_id ?? SHOP_WORKFLOW,
        slug: `${id}-assistant`,
        name: id === "shop" ? "Shop assistant" : "Blog assistant",
        lifecycle: "active",
        is_assistant: true,
        definition_valid: true,
      },
    ],
    budget_today: {
      bucket: product?.budget_bucket ?? "chat",
      day: "2026-10-16",
      tz: "Europe/Berlin",
      resets_at: "2026-10-16T22:00:00.000Z",
      consumed: 7,
      reserved: 1,
      refusals_today: 2,
    },
    checks: [
      {
        key: "product_configured",
        ok: Boolean(product),
        message: "App settings exist",
        next_action: null,
      },
      {
        key: "execution_authority",
        ok: id !== "shop",
        message: "The assistant workflow has no execution approval",
        next_action: "Approve the assistant workflow for prod",
      },
    ],
  };
}

export async function verifyPeopleApps(page, stand) {
  const state = {
    revision: 30,
    providers: [API_KEY, SHOP_BEARER, BROWSER, BLOG_BEARER],
    products: { blog: BLOG, shop: SHOP },
  };
  const patches = [];
  const activations = [];
  const userQueries = [];
  const erasures = [];
  let erased = false;
  let eraseFails = true;
  let conflictOnce = false;
  await page.route("**/v1/apps**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const ids = ["blog", "shop"];
    if (request.method() === "DELETE") {
      erasures.push(path);
      if (eraseFails) {
        eraseFails = false;
        return json(route, { code: "forbidden", message: "administrator required" }, 403);
      }
      erased = true;
      return json(route, { user_id: SHOP_USER, app_id: "shop", erased: true });
    }
    if (path === "/v1/apps")
      return json(route, { items: ids.map((id) => summary(id, state.products[id], erased)) });
    const id = decodeURIComponent(path.split("/").at(-1));
    if (!ids.includes(id)) return json(route, { error: { code: "not_found" } }, 404);
    return json(route, view(id, state.products[id], erased));
  });
  await page.route("**/v1/settings**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/settings" && request.method() === "GET")
      return json(route, settingsResponse(state));
    if (path === "/v1/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON();
      patches.push(body);
      if (conflictOnce) {
        conflictOnce = false;
        state.revision += 1;
        return json(route, { error: { code: "conflict", message: "revision moved" } }, 409);
      }
      require(body.expected_revision === state.revision, "a save built on a stale revision");
      state.revision += 1;
      if (body.changes.products) state.products = body.changes.products;
      if (body.changes["auth.providers"]) state.providers = body.changes["auth.providers"];
      return json(route, { saved_revision: state.revision });
    }
    if (/^\/v1\/settings\/revisions\/\d+\/activate$/.test(path) && request.method() === "POST") {
      activations.push(path);
      return json(route, {
        saved_revision: state.revision,
        active_revision: state.revision,
        activation_status: "active",
        pending_restart_fields: [],
        replicas: [],
      });
    }
    return route.fallback();
  });
  await page.route("**/v1/identity/users**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/v1/identity/users") return route.fallback();
    userQueries.push(url.searchParams.get("product_id"));
    const appUser = {
      id: SHOP_USER,
      email: "shop-bearer:4b1d0000-0000-4000-8000-0000000000aa@invalid",
      display_name: null,
      role: "enduser",
      status: "active",
      groups: null,
      identities: [
        {
          provider_id: "shop-bearer",
          product_id: "shop",
          last_seen_at: "2026-10-15T08:00:00.000Z",
        },
      ],
    };
    const operator = {
      id: "018f4b4a-6d33-7b3a-9c2d-0000000000c4",
      email: "operator@example.com",
      display_name: null,
      role: "admin",
      status: "active",
      groups: null,
      identities: [],
    };
    const everyone = erased ? [operator] : [operator, appUser];
    const items =
      url.searchParams.get("product_id") === "shop" ? (erased ? [] : [appUser]) : everyone;
    return json(route, { items, total: items.length });
  });
  await page.route("**/v1/workflows?**", (route) =>
    json(route, {
      items: [
        {
          id: SHOP_WORKFLOW,
          name: "Shop assistant",
          slug: "shop-assistant",
          current_version_id: null,
        },
        {
          id: BLOG_WORKFLOW,
          name: "Blog assistant",
          slug: "blog-assistant",
          current_version_id: null,
        },
      ],
      total: 2,
    }),
  );

  await stand.visit(page, "people?section=apps");
  await page.getByTestId("apps-section").waitFor();
  const readiness = await page.getByTestId("apps-list-1-readiness").getAttribute("data-state");
  require(readiness === "needs_attention", `the shop app reads as ${readiness}`);

  await page.getByTestId("apps-list-row-link-1").filter({ visible: true }).click();
  const sheet = page.getByTestId("apps-sheet");
  await sheet.getByTestId("apps-check-execution_authority-next").waitFor();
  require((await sheet.getByTestId("apps-sheet-budget-facts").innerText()).includes(
    "7",
  ), "today's budget is missing from the app details");

  await sheet.getByTestId("apps-sheet-menu").click();
  await page.getByTestId("apps-edit-settings").click();
  const settings = page.getByTestId("apps-settings-dialog");
  await settings.getByTestId("apps-settings-bucket").fill("support");
  conflictOnce = true;
  await settings.getByTestId("apps-settings-submit").click();
  await settings.getByTestId("apps-settings-dialog-error").waitFor();
  require(activations.length === 0, "a refused save was activated");
  await settings.getByTestId("apps-settings-submit").click();
  await settings.waitFor({ state: "detached" });
  const productSave = patches.at(-1);
  same(
    Object.keys(productSave.changes),
    ["products"],
    "an app settings save touched more than products",
  );
  same(productSave.changes.products.blog, BLOG, "saving the shop app changed the blog app");
  same(
    productSave.changes.products.shop,
    { ...SHOP, budget_bucket: "support" },
    "the shop app was not replaced",
  );
  require(activations.length === 1, "the saved revision was not activated");

  await sheet.getByTestId("apps-sheet-menu").click();
  await page.getByTestId("apps-edit-sign-in").click();
  const signIn = page.getByTestId("apps-sign-in-dialog");
  await signIn.getByTestId("apps-sign-in-audience").fill("shop-api");
  await signIn.getByTestId("apps-sign-in-claim-add").click();
  await signIn.getByTestId("apps-sign-in-claim-1-path").fill("app_metadata.plan");
  await signIn.getByTestId("apps-sign-in-claim-1-value").fill("pro");
  await signIn.getByTestId("apps-sign-in-submit").click();
  await signIn.waitFor({ state: "detached" });
  const providerSave = patches.at(-1);
  same(
    Object.keys(providerSave.changes),
    ["auth.providers"],
    "a sign-in save touched more than providers",
  );
  const providers = providerSave.changes["auth.providers"];
  same(
    providers.map((provider) => provider.id),
    ["api-key", "shop-bearer", "example-sso", "blog-bearer"],
    "the provider order changed",
  );
  same(providers[0], API_KEY, "the api key provider changed");
  same(providers[2], BROWSER, "the browser provider changed");
  same(providers[3], BLOG_BEARER, "the blog provider changed");
  same(
    providers[1],
    {
      ...SHOP_BEARER,
      audience: "shop-api",
      required_claims: [
        { path: "role", equals: "authenticated" },
        { path: "app_metadata.plan", equals: "pro" },
      ],
    },
    "the shop provider was not edited in place",
  );

  await sheet.getByTestId("apps-sheet-menu").click();
  await page.getByTestId("apps-remove").click();
  await page.getByTestId("apps-remove-confirm-confirm").click();
  await page.getByTestId("apps-remove-confirm").waitFor({ state: "detached" });
  same(patches.at(-1).changes, { products: { blog: BLOG } }, "removing the shop app removed more");

  await stand.visit(page, "people?section=apps");
  await page.getByTestId("apps-section").waitFor();
  await page.getByTestId("apps-list-row-link-1").filter({ visible: true }).click();
  const users = sheet.getByTestId("apps-users-list");
  await users.waitFor();
  require(userQueries.includes("shop"), "the app users were not filtered by app");
  const row = await sheet.getByTestId("apps-users-0").innerText();
  require(row.includes("App-Nutzer · shop-bearer"), `the app user row reads as ${row}`);
  require(row.includes(SHOP_USER.slice(0, 8)), "the row does not tell users apart");
  require(!row.includes("@invalid"), "a placeholder address is shown in the app users");
  require((await sheet.getByTestId("apps-users-0").getByRole("button").count()) ===
    1, "the user row offers more than one action");

  await sheet.getByTestId("apps-users-0-erase").click();
  const confirm = page.getByTestId("apps-users-erase-confirm");
  const consequence = await confirm.getByTestId("apps-users-erase-confirm-consequence").innerText();
  require(consequence.includes("Anmeldeanbieter"), `the consequence reads as ${consequence}`);
  require(consequence.includes("nicht rückgängig"), "the erase does not say it cannot be undone");
  await confirm.getByTestId("apps-users-erase-confirm-cancel").click();
  await confirm.waitFor({ state: "detached" });
  require(erasures.length === 0, "cancelling the dialog erased the user");
  await sheet.getByTestId("apps-users-0").waitFor();

  await sheet.getByTestId("apps-users-0-erase").click();
  await confirm.getByTestId("apps-users-erase-confirm-confirm").click();
  await page
    .getByText("Nicht geändert: Dein Zugang erlaubt diese Änderung nicht.")
    .first()
    .waitFor();
  require(erasures.length === 1, "a refused erase was not sent once");
  require(!erased, "a refused erase removed the user");
  await sheet.getByTestId("apps-users-0").waitFor();

  await confirm.getByTestId("apps-users-erase-confirm-confirm").click();
  await confirm.waitFor({ state: "detached" });
  same(
    erasures,
    [`/v1/apps/shop/users/${SHOP_USER}`, `/v1/apps/shop/users/${SHOP_USER}`],
    "the erase hit another path",
  );
  await sheet.getByTestId("apps-users-none").waitFor();
  require((await sheet.getByTestId("apps-users-0").count()) ===
    0, "the erased user is still listed");
  require(erased, "the erase did not reach the engine");
}
