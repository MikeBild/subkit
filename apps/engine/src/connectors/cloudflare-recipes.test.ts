import { describe, expect, test } from "bun:test";
import { compileRequestBoundary, requestBoundaryViolation } from "../workflows/request-boundary.ts";
import type { RequestStep } from "../workflows/types.ts";
import { bindRecipe } from "./recipe-binding.ts";
import { getBuiltinTemplate } from "./templates.ts";

describe("cloudflare recipes (#712)", () => {
  const placeholder = "00000000-0000-0000-0000-000000000000";
  const cloudflare = getBuiltinTemplate("cloudflare")!;
  const stepOf = (slug: string): RequestStep =>
    cloudflare.recipes.find((recipe) => recipe.slug === slug)!.workflow.steps[0] as RequestStep;
  const violationFor = (slug: string, url: string) =>
    requestBoundaryViolation(compileRequestBoundary(stepOf(slug), cloudflare.base_url).boundary!, {
      method: "GET",
      url,
      headers: {},
      body: null,
    });

  test("every cloudflare request step binds the cloudflare connector and compiles a request boundary", () => {
    const outcomes = cloudflare.recipes.flatMap((recipe) =>
      (recipe.workflow.steps as RequestStep[]).map((step) => ({
        step: `${recipe.slug}/${step.id}`,
        connector_id: step.connector_id,
        url: step.url ?? null,
        required: recipe.required_connectors.find((r) => r.placeholder === placeholder)?.template,
        refusal: compileRequestBoundary(step, cloudflare.base_url).refusal ?? null,
      })),
    );
    expect(outcomes.map((outcome) => outcome.step).sort()).toEqual([
      "list-dns-records/list_dns_records",
      "list-zones/list_zones",
      "verify-token/verify",
    ]);
    expect(outcomes).toEqual(
      outcomes.map((outcome) => ({
        ...outcome,
        connector_id: placeholder,
        url: null,
        required: "cloudflare",
        refusal: null,
      })),
    );
  });

  test("binding replaces the placeholder with the one enabled cloudflare connector", () => {
    const chosen = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const templates = new Map([
      ["cloudflare", { name: cloudflare.name, base_url: cloudflare.base_url }],
    ]);
    const row = {
      id: chosen,
      slug: "cloudflare",
      display_name: "Cloudflare",
      template_slug: "cloudflare",
      enabled: true,
    };
    const boundIds = cloudflare.recipes.flatMap((recipe) =>
      (bindRecipe(recipe, [row], templates).workflow.steps as RequestStep[]).map(
        (step) => step.connector_id,
      ),
    );
    expect(boundIds).toEqual([chosen, chosen, chosen]);
  });

  test("the bound boundaries admit the requests the recipes send", () => {
    expect([
      violationFor("verify-token", "https://api.cloudflare.com/client/v4/user/tokens/verify"),
      violationFor("list-zones", "https://api.cloudflare.com/client/v4/zones?page=2&per_page=50"),
      violationFor(
        "list-dns-records",
        "https://api.cloudflare.com/client/v4/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records?page=1&per_page=100",
      ),
    ]).toEqual([null, null, null]);
  });
});
