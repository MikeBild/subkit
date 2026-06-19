// GC6 — openapi external `$ref` follows capped at 20.
//
// The llms.txt 20-link cap is already covered by budget-caps.test.ts.
// This test exercises the matching cap on the openapi source: a root
// spec with 25 distinct external file refs should only trigger 20
// follow-fetches and record exactly MAX_LINKS on the budget state.

import { describe, expect, test } from "bun:test";
import { createBudgetState, MAX_LINKS } from "../budgets.ts";
import { collectExternalRefs, ingestOpenAPIUrl } from "../sources/openapi.ts";

const ROOT_URL = "https://api.test/openapi.json";

function buildRootSpec(refCount: number) {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < refCount; i += 1) {
    paths[`/resource-${i}`] = {
      get: {
        summary: `get resource ${i}`,
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: `schemas/resource-${i}.json#/Resource` },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: "3.0.0",
    info: { title: "refs", version: "1.0.0" },
    paths,
  };
}

function buildChildSpec(index: number) {
  return {
    openapi: "3.0.0",
    info: { title: `child-${index}`, version: "1.0.0" },
    paths: {
      [`/child-${index}`]: {
        get: { summary: `child ${index}`, responses: { "200": { description: "ok" } } },
      },
    },
  };
}

describe("docs-ingestion/openapi external $ref cap", () => {
  test("collectExternalRefs ignores in-document fragments", () => {
    const refs = collectExternalRefs(
      {
        paths: {
          "/a": { get: { responses: { "200": { $ref: "#/components/responses/Ok" } } } },
          "/b": { get: { responses: { "200": { $ref: "schemas/ok.json#/Ok" } } } },
        },
      },
      ROOT_URL,
    );
    expect(refs.length).toBe(1);
    expect(refs[0]).toContain("schemas/ok.json");
  });

  test("25 external refs -> only MAX_LINKS (20) are followed", async () => {
    const root = buildRootSpec(25);
    const rootBody = JSON.stringify(root);
    let childFetches = 0;

    const fetchImpl = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ROOT_URL) {
        return new Response(rootBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const match = /resource-(\d+)\.json/.exec(url);
      childFetches += 1;
      const idx = match ? Number(match[1]) : childFetches;
      return new Response(JSON.stringify(buildChildSpec(idx)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const state = createBudgetState();
    const result = await ingestOpenAPIUrl(ROOT_URL, state, fetchImpl);
    expect(state.links_followed).toBe(MAX_LINKS);
    expect(childFetches).toBe(MAX_LINKS);
    // The root chunks + 20 child chunks should all land in the output.
    expect(result.chunks.length).toBeGreaterThanOrEqual(MAX_LINKS);
  });
});
