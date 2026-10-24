import { describe, expect, test } from "bun:test";
import { resolveTemplateResourceUrl } from "./resource-url.ts";
import { loadBuiltinTemplates } from "./templates.ts";

const NOTION_URL = "https://www.notion.so/acme/Roadmap-0123456789abcdef0123456789abcdef";
const JIRA_URL = "https://acme.atlassian.net/browse/OPS-42";

describe("resolveTemplateResourceUrl", () => {
  test("built-in templates declare the resource URL parsers", () => {
    const declared = Object.fromEntries(
      loadBuiltinTemplates()
        .filter((template) => template.resource_url_parser)
        .map((template) => [template.slug, template.resource_url_parser]),
    );
    expect(declared).toEqual({
      confluence: "atlassian_cloud",
      jira: "atlassian_cloud",
      notion: "notion",
    });
  });

  test("decodes a resource URL through a declared parser", () => {
    const builtin = loadBuiltinTemplates();
    expect(resolveTemplateResourceUrl(JIRA_URL, builtin)).toEqual({
      kind: "jira_issue",
      key: "OPS-42",
    });
    expect(resolveTemplateResourceUrl(NOTION_URL, builtin)).toEqual({
      kind: "notion_page",
      page_id: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(
      resolveTemplateResourceUrl(NOTION_URL, [{ resource_url_parser: "atlassian_cloud" }]),
    ).toBeNull();
  });

  test("templates without a declared parser resolve nothing", () => {
    expect(resolveTemplateResourceUrl(JIRA_URL, [])).toBeNull();
    expect(resolveTemplateResourceUrl(NOTION_URL, [{ resource_url_parser: null }])).toBeNull();
    expect(
      resolveTemplateResourceUrl("https://api.stripe.com/v1/charges", loadBuiltinTemplates()),
    ).toBeNull();
  });
});
