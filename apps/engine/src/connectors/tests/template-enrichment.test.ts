import { describe, expect, test } from "bun:test";
import { enrichConnectorFromTemplate } from "../template-enrichment.ts";
import { getBuiltinTemplate } from "../templates.ts";

describe("enrichConnectorFromTemplate — stripe (bearer, no oauth)", () => {
  const template = getBuiltinTemplate("stripe")!;

  test("template is found", () => {
    expect(template).not.toBeNull();
  });

  test("user-provided name wins over template default", () => {
    const result = enrichConnectorFromTemplate({ name: "My Stripe" }, template);
    expect(result.name).toBe("My Stripe");
  });

  test("template name used when user provides none", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.name).toBe(template.name);
  });

  test("driver defaults to template driver", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.driver).toBe("http");
  });

  test("environment defaults to dev", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.environment).toBe("dev");
  });

  test("user environment is preserved", () => {
    const result = enrichConnectorFromTemplate({ environment: "prod" }, template);
    expect(result.environment).toBe("prod");
  });

  test("base_url falls back to template base_url when not supplied", () => {
    const result = enrichConnectorFromTemplate({}, template);
    // template.base_url is non-null in the Stripe fixture; otherwise the
    // field is omitted from the enriched draft so the operator is asked.
    expect(result.base_url).toBe(template.base_url as string);
  });

  test("user-supplied base_url wins", () => {
    const result = enrichConnectorFromTemplate(
      { base_url: "https://custom.stripe.test" },
      template,
    );
    expect(result.base_url).toBe("https://custom.stripe.test");
  });

  test("probe_endpoint is merged into config", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.config?.probe_endpoint).toEqual(template.probe_endpoint);
  });

  test("capabilities are merged into config", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.config?.capabilities).toEqual(template.capabilities);
  });

  test("pagination_defaults are merged into config", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.config?.pagination_defaults).toEqual(template.pagination_defaults);
  });

  test("credential_hints are merged into config", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.config?.credential_hints).toEqual(template.credential_hints);
  });

  test("user-supplied config fields are preserved (non-destructive)", () => {
    const result = enrichConnectorFromTemplate({ config: { my_flag: true } }, template);
    expect(result.config?.my_flag).toBe(true);
  });

  test("user config fields are NOT overwritten by template defaults", () => {
    const result = enrichConnectorFromTemplate(
      {
        config: {
          probe_endpoint: {
            method: "HEAD",
            path: "/",
            expected_status: [200, 200],
            description: "",
          },
        },
      },
      template,
    );
    expect((result.config?.probe_endpoint as { method: string })?.method).toBe("HEAD");
  });
});

describe("enrichConnectorFromTemplate — salesforce (base_url_options + oauth2)", () => {
  const template = getBuiltinTemplate("salesforce")!;

  test("template is found", () => {
    expect(template).not.toBeNull();
  });

  test("no environment hint → first base_url_options entry used", () => {
    const result = enrichConnectorFromTemplate({}, template);
    expect(result.base_url).toBe(template.base_url_options[0]!.base_url);
  });

  test("sandbox environment hint selects sandbox base_url", () => {
    const result = enrichConnectorFromTemplate({}, template, { environment: "sandbox" });
    const sandboxOption = template.base_url_options.find((o) => o.environment === "sandbox");
    expect(result.base_url).toBe(sandboxOption!.base_url);
  });

  test("production environment hint selects production base_url", () => {
    const result = enrichConnectorFromTemplate({}, template, { environment: "production" });
    const prodOption = template.base_url_options.find((o) => o.environment === "production");
    expect(result.base_url).toBe(prodOption!.base_url);
  });

  test("oauth fields flow into config.oauth when auth_type=oauth2", () => {
    if (template.oauth) {
      const result = enrichConnectorFromTemplate({ auth_type: "oauth2" }, template);
      const oauth = result.config?.oauth as Record<string, unknown> | undefined;
      expect(oauth?.issuer_url).toBe(template.oauth.issuer_url);
      expect(oauth?.grant_type).toBe(template.oauth.grant_type);
    }
  });

  test("oauth fields are NOT seeded when auth_type=bearer", () => {
    if (template.oauth) {
      const result = enrichConnectorFromTemplate({ auth_type: "bearer" }, template);
      expect(result.config?.oauth).toBeUndefined();
    }
  });
});
