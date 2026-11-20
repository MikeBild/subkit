import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CATEGORY_KINDS,
  CategoryEditSchema,
  CategoryFilterSchema,
  type CategoryKind,
  CategoryMetadataSchema,
} from "../../api/catalog-metadata.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { actorType } from "../../audit/index.ts";
import { can, hasBuiltinAdminRole } from "../../rbac/index.ts";
import {
  CategoryRenameRefused,
  CategoryRevisionConflict,
  categoryRenameAffectsIntake,
  categoryRenameAffectsTasks,
  loadCategoryVocabulary,
  renameCategory,
} from "../../workflows/index.ts";
import { BadRequestError, ConflictError, ForbiddenError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const READ_PERMISSION: Record<CategoryKind, string> = {
  workflow: "workflow:read",
  connector: "connector:read",
  knowledge_source: "knowledge:read",
  skill: "skill:read",
  file: "file:read",
  task: "task:read",
  intake: "intake:read",
};

const KindCountsSchema = z
  .object({
    workflow: z.number().int().nonnegative(),
    connector: z.number().int().nonnegative(),
    knowledge_source: z.number().int().nonnegative(),
    skill: z.number().int().nonnegative(),
    file: z.number().int().nonnegative(),
    task: z.number().int().nonnegative(),
    intake: z.number().int().nonnegative(),
  })
  .openapi("CategoryKindCounts");

const CategoryUsageSchema = z
  .object({
    ...CategoryMetadataSchema.shape,
    category: z.string(),
    total: z.number().int().nonnegative(),
    counts: KindCountsSchema,
    llm_counts: KindCountsSchema,
    intake_open: z.object({
      collected: z.number().int().nonnegative(),
      reviewing: z.number().int().nonnegative(),
    }),
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
    requireAnyPermission(CATEGORY_KINDS.map((kind) => READ_PERMISSION[kind])),
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
    const readable = new Set<CategoryKind>();
    for (const kind of CATEGORY_KINDS) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: READ_PERMISSION[kind],
        quiet: true,
      });
      if (decision.allow) readable.add(kind);
    }
    const categories = (
      await loadCategoryVocabulary(principal.tenant_id, db, {
        task_owner_id: hasBuiltinAdminRole(principal) ? null : principal.id,
      })
    )
      .map((usage) => {
        const counts = { ...usage.counts };
        const llm_counts = { ...usage.llm_counts };
        const intake_open = { ...usage.intake_open };
        for (const kind of CATEGORY_KINDS)
          if (!readable.has(kind)) {
            counts[kind] = 0;
            llm_counts[kind] = 0;
            if (kind === "intake") intake_open.collected = intake_open.reviewing = 0;
          }
        return {
          ...usage,
          category: usage.category,
          counts,
          llm_counts,
          intake_open,
          total: CATEGORY_KINDS.reduce((sum, kind) => sum + counts[kind], 0),
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
    if (await categoryRenameAffectsIntake({ tenant_id: principal.tenant_id, from: name }, db)) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "intake:write",
        quiet: true,
      });
      if (!decision.allow) throw new ForbiddenError("permission_denied:intake:write");
    }
    if (await categoryRenameAffectsTasks({ tenant_id: principal.tenant_id, from: name }, db)) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "task:write",
        quiet: true,
      });
      if (!decision.allow) throw new ForbiddenError("permission_denied:task:write");
    }
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
