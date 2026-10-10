import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CATALOG_KINDS,
  type CatalogKind,
  CategoryEditSchema,
  CategoryFilterSchema,
  CategoryMetadataSchema,
} from "../../api/catalog-metadata.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { actorType } from "../../audit/index.ts";
import { can } from "../../rbac/index.ts";
import {
  CategoryRenameRefused,
  CategoryRevisionConflict,
  loadCategoryVocabulary,
  renameCategory,
} from "../../workflows/index.ts";
import { BadRequestError, ConflictError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const READ_PERMISSION: Record<CatalogKind, string> = {
  workflow: "workflow:read",
  connector: "connector:read",
  knowledge_source: "knowledge:read",
  skill: "skill:read",
  file: "file:read",
};

const KindCountsSchema = z
  .object({
    workflow: z.number().int().nonnegative(),
    connector: z.number().int().nonnegative(),
    knowledge_source: z.number().int().nonnegative(),
    skill: z.number().int().nonnegative(),
    file: z.number().int().nonnegative(),
  })
  .openapi("CategoryKindCounts");

const CategoryUsageSchema = z
  .object({
    ...CategoryMetadataSchema.shape,
    category: z.string(),
    total: z.number().int().nonnegative(),
    counts: KindCountsSchema,
    llm_counts: KindCountsSchema,
  })
  .openapi("CategoryUsage");

const CategoryListResponse = z
  .object({ categories: z.array(CategoryUsageSchema) })
  .openapi("CategoryListResponse");

const RenameCategoryBody = CategoryEditSchema.openapi("RenameCategoryBody");

const RenameCategoryResponse = z
  .object({
    from: z.string(),
    to: z.string(),
    total: z.number().int(),
    moved: KindCountsSchema,
    metadata: CategoryMetadataSchema,
    purpose_generation: z.enum(["pending", "not_requested"]),
  })
  .openapi("RenameCategoryResponse");

const listRoute = createRoute({
  method: "get",
  path: "/v1/categories",
  tags: ["categories"],
  summary: "List the tenant's catalog categories with how many objects of each kind use them",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: CategoryListResponse } } },
  },
});

const renameRoute = createRoute({
  method: "post",
  path: "/v1/categories/{name}/rename",
  tags: ["categories"],
  summary: "Rename or merge a catalog category across every kind",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      name: CategoryFilterSchema.openapi({ param: { name: "name", in: "path" } }),
    }),
    body: { content: { "application/json": { schema: RenameCategoryBody } } },
  },
  responses: {
    200: {
      description: "Renamed",
      content: { "application/json": { schema: RenameCategoryResponse } },
    },
    409: {
      description: "Metadata changed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCategoryRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/categories",
    requireAnyPermission(CATALOG_KINDS.map((kind) => READ_PERMISSION[kind])),
  );
  app.use(
    "/v1/categories/:name/rename",
    requirePermission("workflow:write"),
    requirePermission("connector:write"),
    requirePermission("knowledge:write"),
    requirePermission("skill:write"),
    requirePermission("file:write"),
  );

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const readable = new Set<CatalogKind>();
    for (const kind of CATALOG_KINDS) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: READ_PERMISSION[kind],
        quiet: true,
      });
      if (decision.allow) readable.add(kind);
    }
    const categories = (await loadCategoryVocabulary(principal.tenant_id, db))
      .map((usage) => {
        const counts = { ...usage.counts };
        const llm_counts = { ...usage.llm_counts };
        for (const kind of CATALOG_KINDS)
          if (!readable.has(kind)) {
            counts[kind] = 0;
            llm_counts[kind] = 0;
          }
        return {
          ...usage,
          category: usage.category,
          counts,
          llm_counts,
          total: CATALOG_KINDS.reduce((sum, kind) => sum + counts[kind], 0),
        };
      })
      .filter((usage) => usage.total > 0);
    return c.json({ categories }, 200);
  });

  app.openapi(renameRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const { to } = body;
    try {
      const result = await renameCategory(
        {
          tenant_id: principal.tenant_id,
          from: name,
          ...body,
          actor_type: actorType(principal),
          actor_id: principal.id,
        },
        db,
      );
      return c.json({ from: name, to, ...result }, 200);
    } catch (err) {
      if (err instanceof CategoryRevisionConflict) throw new ConflictError(err.message);
      if (err instanceof CategoryRenameRefused) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
