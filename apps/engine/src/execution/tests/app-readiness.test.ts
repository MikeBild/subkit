import { describe, expect, test } from "bun:test";
import type { AppSignIn } from "../../api/app-schemas.ts";
import type { AuthProviderConfig, ProductConfig } from "../../config/schema.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";
import { tenantSignIn, visibleAppIds } from "../apps.ts";
import {
  type AssistantRecord,
  deriveProductChecks,
  type ProductReadinessFacts,
  storedProductId,
} from "../product-status.ts";

const ASSISTANT_ID = "00000000-0000-4000-8000-0000000000a1";

const product: ProductConfig = {
  execution_environment: "prod",
  assistant_workflow_id: ASSISTANT_ID,
  budget_bucket: "brain",
};

const bearerSignIn: AppSignIn = {
  id: "testapp-bearer",
  label: "TE-Kit",
  protocol: "oidc_bearer",
  issuer_url: "https://issuer.example.test",
  tenant_slug: "default",
  audience: "authenticated",
  algorithms: ["ES256"],
  required_claims: [],
  reject_anonymous: true,
};

function definition(overrides: Record<string, unknown> = {}): WorkflowDef {
  return WorkflowDefSchema.parse({
    name: "brain-round",
    product_id: "testapp",
    required_caller_kind: "user",
    execution_privacy: "sensitive",
    steps: [{ id: "round", kind: "transform", expression: "return {};" }],
    execution_guards: {
      caller_daily_limit: {
        bucket: "brain",
        limit: 5,
        tz: "Europe/Berlin",
        unit: "turn_id",
        billable_steps: ["round"],
        max_metered: 3,
        commit_when: "true",
      },
    },
    ...overrides,
  });
}

function assistant(overrides: Partial<AssistantRecord> = {}): AssistantRecord {
  const def = overrides.definition === undefined ? definition() : overrides.definition;
  return {
    id: ASSISTANT_ID,
    name: "brain-round",
    slug: "brain-round",
    lifecycle: "active",
    version_id: "00000000-0000-4000-8000-0000000000b1",
    definition: def,
    product_id: def?.product_id ?? null,
    ...overrides,
  };
}

function facts(overrides: Partial<ProductReadinessFacts> = {}): ProductReadinessFacts {
  return {
    product_id: "testapp",
    product,
    sign_in: [bearerSignIn],
    assistant: assistant(),
    authority_live: true,
    credentials_present: true,
    ...overrides,
  };
}

function failing(input: ProductReadinessFacts) {
  return deriveProductChecks(input)
    .filter((item) => !item.ok)
    .map((item) => item.key);
}

function checkOf(input: ProductReadinessFacts, key: string) {
  const found = deriveProductChecks(input).find((item) => item.key === key);
  if (!found) throw new Error(`missing check ${key}`);
  return found;
}

describe("app readiness checks", () => {
  test("a configured, signed-in, active and authorized app passes every check", () => {
    const checks = deriveProductChecks(facts());
    expect(checks.map((item) => item.key)).toEqual([
      "product_configured",
      "sign_in_provider",
      "assistant_workflow",
      "execution_authority",
      "credentials",
      "budget_guard",
    ]);
    expect(checks.every((item) => item.ok && item.next_action === null)).toBe(true);
  });

  test("an inactive assistant workflow fails the assistant check and blocks authority and credentials", () => {
    const input = facts({ assistant: assistant({ lifecycle: "draft" }) });
    expect(failing(input)).toEqual(["assistant_workflow", "execution_authority", "credentials"]);
    expect(checkOf(input, "assistant_workflow")).toMatchObject({
      message: "brain-round is draft",
      next_action: "Activate brain-round",
    });
  });

  test("a guard bucket that differs from budget_bucket fails only the budget check", () => {
    const input = facts({ product: { ...product, budget_bucket: "chat" } });
    expect(failing(input)).toEqual(["budget_guard"]);
    expect(checkOf(input, "budget_guard").next_action).toBe(
      "Align products.testapp.budget_bucket with the guard's bucket brain",
    );
  });

  test("an assistant workflow declaring a foreign product_id is not this app's assistant", () => {
    const input = facts({
      assistant: assistant({ definition: definition({ product_id: "otherkit" }) }),
    });
    expect(failing(input)).toEqual(["assistant_workflow", "execution_authority", "credentials"]);
    expect(checkOf(input, "assistant_workflow").message).toBe(
      "brain-round declares product_id otherkit",
    );
  });

  test("an invalid assistant version fails readiness instead of throwing", () => {
    const input = facts({ assistant: assistant({ definition: null, product_id: "testapp" }) });
    expect(failing(input)).toEqual([
      "assistant_workflow",
      "execution_authority",
      "credentials",
      "budget_guard",
    ]);
    expect(checkOf(input, "assistant_workflow").next_action).toBe(
      "Save brain-round again in the current definition format",
    );
  });

  test("an orphan app without products settings fails configuration and points at settings", () => {
    const input = facts({ product: null, assistant: null });
    expect(failing(input)).toEqual([
      "product_configured",
      "assistant_workflow",
      "execution_authority",
      "credentials",
      "budget_guard",
    ]);
    expect(checkOf(input, "product_configured").next_action).toContain("products.testapp");
  });

  test("a missing guard and missing sign-in provider each name their next action", () => {
    const input = facts({
      sign_in: [],
      assistant: assistant({ definition: definition({ execution_guards: undefined }) }),
    });
    expect(failing(input)).toEqual(["sign_in_provider", "budget_guard"]);
    expect(checkOf(input, "sign_in_provider").next_action).toBe(
      "Add an oidc_bearer provider with product_id testapp under auth.providers",
    );
  });
});

describe("app visibility", () => {
  const providers: AuthProviderConfig[] = [
    { protocol: "api_key", id: "api-key", label: "SubKit API key" },
    {
      protocol: "oidc_bearer",
      id: "orphan-bearer",
      label: "Orphan",
      issuer_url: "https://orphan.example.test",
      audience: "authenticated",
      algorithms: ["ES256"],
      product_id: "orphan",
      tenant_slug: "acme",
      required_claims: [{ path: "app", equals: "orphan" }],
      reject_anonymous: true,
      clock_tolerance_s: 30,
    },
    {
      protocol: "oidc_bearer",
      id: "foreign-bearer",
      label: "Foreign",
      issuer_url: "https://foreign.example.test",
      audience: "authenticated",
      algorithms: ["ES256"],
      product_id: "foreignkit",
      tenant_slug: "other",
      required_claims: [],
      reject_anonymous: true,
      clock_tolerance_s: 30,
    },
    {
      protocol: "oidc",
      id: "browser",
      label: "Browser",
      issuer_url: "https://browser.example.test",
      client_id: "client",
      scopes: "openid",
      tenant_slug: "acme",
    },
  ];

  test("only providers of the workspace slug with a product_id contribute sign-in", () => {
    const signIn = tenantSignIn(providers, "acme");
    expect([...signIn.keys()]).toEqual(["orphan"]);
    expect(signIn.get("orphan")?.[0]).toMatchObject({
      protocol: "oidc_bearer",
      required_claims: [{ path: "app", equals: "orphan" }],
    });
    expect(JSON.stringify(signIn.get("orphan"))).not.toContain("client_id");
  });

  test("visible ids are the union of providers, owned assistants, workflows and identities", () => {
    const ids = visibleAppIds(
      {
        auth: { providers } as never,
        products: {
          testapp: product,
          foreignkit: { ...product, assistant_workflow_id: "00000000-0000-4000-8000-0000000000ff" },
        },
      },
      {
        workflows: [
          { id: ASSISTANT_ID, product_id: null },
          { id: "00000000-0000-4000-8000-0000000000c1", product_id: "flowkit" },
        ],
        users: new Map([["userkit", {}]]),
        signIn: tenantSignIn(providers, "acme"),
      },
    );
    expect(ids).toEqual(["flowkit", "orphan", "testapp", "userkit"]);
  });

  test("a workspace without its own facts sees none of the engine-wide app configuration", () => {
    const ids = visibleAppIds(
      {
        auth: { providers } as never,
        products: { testapp: product },
      },
      { workflows: [], users: new Map(), signIn: tenantSignIn(providers, "other-workspace") },
    );
    expect(ids).toEqual([]);
  });
});

describe("stored product id", () => {
  test("an invalid stored definition contributes its raw product_id only when it is an openable app id", () => {
    expect(storedProductId({ product_id: "testapp" }, null)).toBe("testapp");
    expect(storedProductId({ product_id: "Not An Id" }, null)).toBeNull();
    expect(storedProductId({ product_id: "-leading-dash" }, null)).toBeNull();
    expect(storedProductId({ product_id: "a".repeat(129) }, null)).toBeNull();
    expect(storedProductId({ product_id: 42 }, null)).toBeNull();
    expect(storedProductId(null, null)).toBeNull();
  });
});
