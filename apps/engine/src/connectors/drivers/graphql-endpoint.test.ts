import { describe, expect, test } from "bun:test";
import { graphqlPathShapeError, resolveGraphqlStepEndpoint } from "./graphql-endpoint.ts";

const github = { driver: "http", base_url: "https://api.github.com", auth_type: "bearer" };

describe("resolveGraphqlStepEndpoint", () => {
  test("a graphql connector keeps its base_url and ignores the step path", () => {
    expect(
      resolveGraphqlStepEndpoint({
        driver: "graphql",
        base_url: "https://api.example.com/graphql",
        path: "/ignored",
      }),
    ).toEqual({ ok: true, url: "https://api.example.com/graphql", via_path: false });
  });

  test("an http connector resolves a fixed same-host path", () => {
    expect(resolveGraphqlStepEndpoint({ ...github, path: "/graphql" })).toEqual({
      ok: true,
      url: "https://api.github.com/graphql",
      via_path: true,
    });
  });

  test("a base path prefix is kept", () => {
    const resolved = resolveGraphqlStepEndpoint({
      driver: "http",
      base_url: "https://git.example.com/api",
      path: "/graphql",
    });
    expect(resolved).toEqual({
      ok: true,
      url: "https://git.example.com/api/graphql",
      via_path: true,
    });
  });

  test("a missing path asks for /graphql", () => {
    for (const path of [undefined, null, ""]) {
      const resolved = resolveGraphqlStepEndpoint({ ...github, path });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.code).toBe("graphql_path_required");
      expect(resolved.message).toContain('"/graphql"');
    }
  });

  test.each([
    "graphql",
    "https://evil.example/graphql",
    "http:evil.example",
    "//evil.example/graphql",
    "/a/../graphql",
    "/./graphql",
    "/..",
    "/graphql%2f..",
    "/graphql?x=1",
    "/graphql#x",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: refused placeholder shape
    "/${input.host}",
    "/graphql\\evil.example",
    "/graphql/",
    "/ graphql",
  ])("refuses the path %p without echoing a host", (path) => {
    const resolved = resolveGraphqlStepEndpoint({ ...github, path });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("graphql_endpoint_invalid");
    expect(resolved.message).not.toContain("evil");
    expect(resolved.message).not.toContain("api.github.com");
    expect(graphqlPathShapeError(path)).not.toBeNull();
  });

  test("refuses a step url on an http connector", () => {
    const resolved = resolveGraphqlStepEndpoint({
      ...github,
      path: "/graphql",
      url: "https://evil.example/graphql",
    });
    expect(resolved).toMatchObject({ ok: false, code: "graphql_endpoint_invalid" });
    if (!resolved.ok) expect(resolved.message).not.toContain("evil");
  });

  test("refuses an aws_sigv4 http connector", () => {
    expect(
      resolveGraphqlStepEndpoint({ ...github, auth_type: "aws_sigv4", path: "/graphql" }),
    ).toMatchObject({ ok: false, code: "graphql_endpoint_invalid" });
  });

  test("refuses an http connector without a usable base_url", () => {
    for (const base_url of [null, "", "not a url", "ftp://files.example.com"]) {
      expect(
        resolveGraphqlStepEndpoint({ driver: "http", base_url, path: "/graphql" }),
      ).toMatchObject({ ok: false, code: "graphql_endpoint_invalid" });
    }
  });

  test.each(["postgres", "s3", "mcp"])("refuses driver %s", (driver) => {
    expect(
      resolveGraphqlStepEndpoint({ driver, base_url: "https://x.example", path: "/graphql" }),
    ).toMatchObject({ ok: false, code: "connector_driver_mismatch" });
  });

  test("accepts nested fixed paths", () => {
    expect(graphqlPathShapeError("/api/graphql")).toBeNull();
    expect(graphqlPathShapeError("/v1/graph-ql_~x.y")).toBeNull();
  });
});
