import { describe, expect, test } from "bun:test";
import { safeWebUrl, webHostAllowed } from "./record-url-patterns.ts";
import { ConnectorTemplateSchema, getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

function withPatterns(slug: string, patch: Record<string, unknown>) {
  const base = getBuiltinTemplate(slug);
  if (!base) throw new Error(`missing template ${slug}`);
  return ConnectorTemplateSchema.safeParse({ ...base, ...patch });
}

function messages(result: ReturnType<typeof withPatterns>): string {
  return result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n");
}

describe("record url patterns in the template catalog", () => {
  test("the shipped catalog covers the main systems with https web hosts", () => {
    const covered = loadBuiltinTemplates()
      .filter((t) => t.record_url_patterns.length > 0)
      .map((t) => t.slug)
      .sort();
    expect(covered).toEqual([
      "github",
      "google-calendar",
      "google-docs",
      "google-drive",
      "google-sheets",
      "linear",
      "notion",
      "shopify",
      "stripe",
    ]);
  });

  test("templates without patterns default to empty lists", () => {
    expect(getBuiltinTemplate("airtable")).toMatchObject({
      web_hosts: [],
      record_url_patterns: [],
    });
  });

  test("patterns without web hosts are refused", () => {
    const result = withPatterns("github", { web_hosts: [] });
    expect(messages(result)).toContain("no web_hosts");
  });

  test("a url template on a host outside web_hosts is refused", () => {
    const result = withPatterns("github", {
      record_url_patterns: [
        {
          methods: ["POST"],
          path: "/repos/{owner}/{repo}/issues",
          url_template: "https://evil.example/{owner}",
        },
      ],
    });
    expect(messages(result)).toContain("url_template must be https on a literal host");
  });

  test("a plain http url template or a placeholder host is refused", () => {
    for (const url_template of ["http://github.com/{owner}", "https://{owner}.github.com/x"]) {
      const result = withPatterns("github", {
        record_url_patterns: [{ methods: ["POST"], path: "/repos/{owner}", url_template }],
      });
      expect(result.success).toBe(false);
    }
  });

  test("an entry needs url_field or url_template", () => {
    const result = withPatterns("github", {
      record_url_patterns: [{ methods: ["POST"], path: "/repos/{owner}/{repo}/issues" }],
    });
    expect(messages(result)).toContain("needs url_field or url_template");
  });

  test("REST entries need a path and GraphQL entries must not have one", () => {
    expect(
      messages(
        withPatterns("github", {
          record_url_patterns: [{ methods: ["POST"], url_field: "html_url" }],
        }),
      ),
    ).toContain("needs a request path");
    expect(
      messages(
        withPatterns("linear", {
          record_url_patterns: [{ methods: ["POST"], path: "/graphql", url_field: "x.url" }],
        }),
      ),
    ).toContain("match the response, not a path");
  });

  test("duplicate or dotted path placeholders are refused", () => {
    const result = withPatterns("github", {
      record_url_patterns: [{ methods: ["POST"], path: "/repos/{a}/{a}", url_field: "html_url" }],
    });
    expect(messages(result)).toContain("unique simple names");
  });

  test("web hosts must be lowercase host names", () => {
    expect(withPatterns("github", { web_hosts: ["GitHub.com"] }).success).toBe(false);
    expect(withPatterns("github", { web_hosts: ["https://github.com"] }).success).toBe(false);
  });
});

describe("web host checks", () => {
  test("a wildcard allows exactly one label", () => {
    expect(webHostAllowed("acme.myshopify.com", ["*.myshopify.com"])).toBe(true);
    expect(webHostAllowed("a.b.myshopify.com", ["*.myshopify.com"])).toBe(false);
    expect(webHostAllowed("myshopify.com", ["*.myshopify.com"])).toBe(false);
    expect(webHostAllowed("evilmyshopify.com", ["*.myshopify.com"])).toBe(false);
  });

  test("only https without credentials or port passes", () => {
    expect(safeWebUrl("https://github.com/a", ["github.com"])).toBe("https://github.com/a");
    expect(safeWebUrl("https://github.com:443/a", ["github.com"])).toBe("https://github.com/a");
    expect(safeWebUrl("https://github.com:444/a", ["github.com"])).toBeNull();
    expect(safeWebUrl("http://github.com/a", ["github.com"])).toBeNull();
    expect(safeWebUrl(42, ["github.com"])).toBeNull();
  });
});
