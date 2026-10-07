import { expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { validateWorkflowDef } from "../../../workflows/validator.ts";
import { parsePlaceholders } from "../parser.ts";
import {
  type ResolverContext,
  resolvePlaceholdersTypePreserving,
  resolveStringPlaceholders,
} from "../resolver.ts";
import { findUnsupportedPlaceholders } from "../unsupported.ts";

function callerContext(caller: Record<string, unknown> | null): ResolverContext {
  return {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    environment: "dev",
    db: new Proxy({} as Db, {
      get() {
        throw new Error("caller_placeholder_must_not_query_database");
      },
    }),
    scope: { $caller: caller },
  };
}

test("nullable caller product preserves JSON null but interpolates empty text", async () => {
  const ctx = callerContext({ productId: null });
  const text = await resolveStringPlaceholders(`products/\${caller.productId}/`, ctx);
  expect(text.value).toBe("products//");
  expect(text.unresolved).toEqual([]);
  const json = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
    { productId: `\${caller.productId}`, path: `products/\${caller.productId}/` },
    ctx,
  );
  expect(json.value).toEqual({ productId: null, path: "products//" });
  expect(json.unresolved).toEqual([]);
});

test("callerless identity cannot resolve text or JSON caller fields", async () => {
  const ctx = callerContext(null);
  const text = await resolveStringPlaceholders(`\${caller.productId}`, ctx);
  expect(text.value).toBe(`\${caller.productId}`);
  expect(text.unresolved).toEqual([
    expect.objectContaining({ token: `\${caller.productId}`, code: "path_empty" }),
  ]);
  const json = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
    { productId: `\${caller.productId}` },
    ctx,
  );
  expect(json.value).toEqual({ productId: `\${caller.productId}` });
  expect(json.unresolved).toEqual([
    expect.objectContaining({ token: `\${caller.productId}`, code: "path_empty" }),
  ]);
});

test("trusted caller fields are first class placeholders rather than step references", () => {
  for (const field of ["tenantId", "principalId", "principalKind", "provider", "productId"]) {
    const parsed = parsePlaceholders(`\${caller.${field}}`);
    expect(parsed.errors).toHaveLength(0);
    expect(findUnsupportedPlaceholders(`\${caller.${field}}`)).toEqual([]);
    expect(parsed.tokens).toContainEqual(
      expect.objectContaining({ kind: "caller", path: [field] }),
    );
  }
});

test("caller placeholders reject nested principal traversal", () => {
  for (const field of ["roles.admin", "scopes.all", "principalId.nested"]) {
    expect(parsePlaceholders(`\${caller.${field}}`).errors.length).toBeGreaterThan(0);
  }
});

test("workflow validation accepts caller fields without demanding an input property or step", () => {
  const result = validateWorkflowDef({
    name: "Caller-bound public request",
    steps: [
      {
        id: "pull",
        kind: "request",
        method: "GET",
        url: `https://api.example.test/products/\${caller.principalId}`,
      },
    ],
    input_schema: { type: "object", properties: {} },
  });
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});
