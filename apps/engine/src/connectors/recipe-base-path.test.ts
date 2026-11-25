import { describe, expect, test } from "bun:test";
import { resolveUrl } from "./drivers/resolve-url.ts";
import { getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

type RawStep = Record<string, unknown> & {
  kind?: unknown;
  id?: unknown;
  url?: unknown;
  path?: unknown;
  connector_id?: unknown;
};

const collectRequestSteps = (node: unknown): RawStep[] =>
  Array.isArray(node)
    ? node.flatMap(collectRequestSteps)
    : node && typeof node === "object"
      ? [
          ...((node as RawStep).kind === "request" ? [node as RawStep] : []),
          ...Object.values(node).flatMap(collectRequestSteps),
        ]
      : [];

const basePathOf = (baseUrl: string | null): string => {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
};

const templates = loadBuiltinTemplates();
const basePathBySlug = new Map(
  templates.map((template) => [template.slug, basePathOf(template.base_url)]),
);
const allRequestSteps = templates.flatMap((template) =>
  template.recipes.flatMap((recipe) =>
    collectRequestSteps(recipe.workflow.steps).map((step) => ({
      label: `${template.slug}/${recipe.slug}#${String(step.id)}`,
      url: typeof step.url === "string" ? step.url : "",
    })),
  ),
);

describe("recipe urls do not repeat the connector base path (#583)", () => {
  test("no request step prefixes a connector base_url with its base path again", () => {
    const duplicated = allRequestSteps.flatMap(({ label, url }) =>
      [...url.matchAll(/\$\{connector\.([\w-]+)\.base_url\}(\/[^?#]*)/g)]
        .filter(([, slug, rest]) => {
          const basePath = basePathBySlug.get(slug ?? "") ?? "";
          return basePath !== "" && (rest === basePath || (rest ?? "").startsWith(`${basePath}/`));
        })
        .map(() => `${label}: ${url}`),
    );
    expect(duplicated).toEqual([]);
  });

  test("sendgrid recipes resolve to single /v3 paths", () => {
    const sendgrid = getBuiltinTemplate("sendgrid")!;
    const sendgridUrls = sendgrid.recipes.flatMap((recipe) =>
      collectRequestSteps(recipe.workflow.steps).map((step) => {
        const binding = recipe.required_connectors.find(
          (entry) => entry.placeholder === step.connector_id,
        );
        expect(binding?.template).toBe("sendgrid");
        expect(typeof step.path).toBe("string");
        return resolveUrl(sendgrid.base_url, String(step.path)).href;
      }),
    );
    expect(sendgridUrls).toContain("https://api.sendgrid.com/v3/templates");
    expect(sendgridUrls).toContain("https://api.sendgrid.com/v3/mail/send");
    expect(sendgridUrls).toContain("https://api.sendgrid.com/v3/suppression/bounces");
    expect(sendgridUrls.filter((url) => url.includes("/v3/v3"))).toEqual([]);
  });
});
