import { describe, expect, test } from "bun:test";
import { normalizeSpec } from "./openapi-direct.ts";
import { optionalAuthSchemes, recognizeAuthFromSchemes } from "./recognize-auth.ts";

const BEARER = { bearerAuth: { type: "http", scheme: "bearer" } };
const API_KEY = { apiKey: { type: "apiKey", in: "header", name: "X-Key" } };

function v3(extra: Record<string, unknown>, paths?: Record<string, unknown>) {
  return {
    openapi: "3.0.0",
    info: { title: "local", version: "1" },
    components: { securitySchemes: { ...BEARER, ...API_KEY } },
    paths: paths ?? { "/items": { get: { responses: { "200": { description: "ok" } } } } },
    ...extra,
  };
}

function schemesOf(spec: Record<string, unknown>) {
  return normalizeSpec(spec, "http://localhost:8080/openapi.json").auth_schemes;
}

describe("OpenAPI 3 security requirement", () => {
  test("without root security every declared scheme is optional and the draft stays auth none", () => {
    const schemes = schemesOf(v3({}));
    expect(schemes.every((scheme) => scheme.required === false)).toBe(true);
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
    expect(optionalAuthSchemes(schemes).map((scheme) => scheme.name)).toEqual([
      "bearerAuth",
      "apiKey",
    ]);
  });

  test("without root security an operation that needs a scheme keeps it required", () => {
    const schemes = schemesOf(
      v3(
        {},
        {
          "/items": {
            get: { security: [{ bearerAuth: [] }], responses: { "200": { description: "ok" } } },
          },
        },
      ),
    );
    expect(schemes.find((scheme) => scheme.name === "bearerAuth")?.required).toBe(true);
    expect(schemes.find((scheme) => scheme.name === "apiKey")?.required).toBe(false);
    expect(recognizeAuthFromSchemes(schemes)?.auth_type).toBe("bearer");
  });

  test("root security [] makes the schemes optional", () => {
    const schemes = schemesOf(v3({ security: [] }));
    expect(schemes.every((scheme) => scheme.required === false)).toBe(true);
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
  });

  test("root security with an anonymous alternative {} makes the schemes optional", () => {
    const schemes = schemesOf(v3({ security: [{}, { apiKey: [] }] }));
    expect(schemes.find((scheme) => scheme.name === "apiKey")?.required).toBe(false);
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
  });

  test("root security naming bearer makes only bearer required", () => {
    const schemes = schemesOf(v3({ security: [{ bearerAuth: [] }] }));
    expect(schemes.find((scheme) => scheme.name === "bearerAuth")?.required).toBe(true);
    expect(schemes.find((scheme) => scheme.name === "apiKey")?.required).toBe(false);
    expect(recognizeAuthFromSchemes(schemes)).toEqual({
      auth_type: "bearer",
      scheme_name: "bearerAuth",
    });
    expect(optionalAuthSchemes(schemes).map((scheme) => scheme.name)).toEqual(["apiKey"]);
  });

  test("every operation opting out with security [] overrides a root requirement", () => {
    const schemes = schemesOf(
      v3(
        { security: [{ bearerAuth: [] }] },
        {
          "/items": { get: { security: [], responses: {} } },
          "/health": { get: { security: [], responses: {} } },
        },
      ),
    );
    expect(schemes.every((scheme) => scheme.required === false)).toBe(true);
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
  });

  test("one operation still needing the root scheme keeps it required", () => {
    const schemes = schemesOf(
      v3(
        { security: [{ bearerAuth: [] }] },
        {
          "/items": { get: { security: [], responses: {} } },
          "/admin": { get: { responses: {} } },
        },
      ),
    );
    expect(schemes.find((scheme) => scheme.name === "bearerAuth")?.required).toBe(true);
  });
});

describe("Swagger 2 security requirement", () => {
  const swagger = (extra: Record<string, unknown>) => ({
    swagger: "2.0",
    info: { title: "legacy", version: "1" },
    host: "localhost:8080",
    securityDefinitions: { apiKey: { type: "apiKey", in: "header", name: "X-Key" } },
    paths: { "/things": { get: { responses: { "200": { description: "ok" } } } } },
    ...extra,
  });

  test("securityDefinitions without root security are optional", () => {
    const schemes = schemesOf(swagger({}));
    expect(schemes[0]?.required).toBe(false);
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
  });

  test("root security naming the key makes it required", () => {
    const schemes = schemesOf(swagger({ security: [{ apiKey: [] }] }));
    expect(schemes[0]?.required).toBe(true);
    expect(recognizeAuthFromSchemes(schemes)?.auth_type).toBe("header");
  });
});

describe("schemes from other sources", () => {
  test("a scheme without the required flag still counts as required", () => {
    expect(
      recognizeAuthFromSchemes([{ name: "bearerAuth", type: "http", scheme: "bearer" }]),
    ).toEqual({ auth_type: "bearer", scheme_name: "bearerAuth" });
  });
});
