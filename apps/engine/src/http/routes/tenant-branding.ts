import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import {
  BrandingImageError,
  readTenantBranding,
  readTenantBrandingLogo,
  resetTenantBranding,
  TenantBrandingConflictError,
  TenantBrandingResetSchema,
  TenantBrandingResponseSchema,
  TenantBrandingUpdateSchema,
  tenantBrandingResponse,
  writeTenantBranding,
} from "../../identity/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export const TenantBrandingUpdate = TenantBrandingUpdateSchema.openapi("TenantBrandingUpdate");
export const TenantBrandingResponse =
  TenantBrandingResponseSchema.openapi("TenantBrandingResponse");
const resetSchema = TenantBrandingResetSchema;

export function registerTenantBrandingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/tenant/branding/logo",
    operationId: "getTenantBrandingLogo",
    tags: ["identity"],
    security: [{ bearerAuth: [] }, { browserSession: [] }],
    request: {
      query: z.object({
        theme: z.enum(["light", "dark"]),
        revision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        tenant_context: z.string().uuid().optional(),
      }),
    },
    responses: {
      200: {
        description: "Normalized logo for the current workspace and revision",
        content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } },
      },
      401: { description: "Authentication required" },
      404: { description: "Logo unavailable for this workspace, theme or revision" },
      409: { description: "Browser workspace context changed" },
    },
  });
  const responses = {
    200: {
      description: "Tenant branding",
      content: { "application/json": { schema: TenantBrandingResponse } },
    },
    400: { description: "Invalid request" },
    401: { description: "Authentication required" },
    403: { description: "Permission denied" },
    409: { description: "Concurrent update" },
    413: { description: "Request too large" },
  };
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/tenant/branding",
    operationId: "getTenantBranding",
    tags: ["identity"],
    security: [{ bearerAuth: [] }, { browserSession: [] }],
    responses,
  });
  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/v1/tenant/branding",
    operationId: "updateTenantBranding",
    tags: ["identity"],
    security: [{ bearerAuth: [] }, { browserSession: [] }],
    request: {
      body: { required: true, content: { "application/json": { schema: TenantBrandingUpdate } } },
    },
    responses,
  });
  app.openAPIRegistry.registerPath({
    method: "delete",
    path: "/v1/tenant/branding",
    operationId: "resetTenantBranding",
    tags: ["identity"],
    security: [{ bearerAuth: [] }, { browserSession: [] }],
    request: { body: { required: true, content: { "application/json": { schema: resetSchema } } } },
    responses,
  });
  app.use("/v1/tenant/branding", async (c, next) => {
    if (c.req.method === "GET") return await next();
    await requirePermission("settings:write")(c, async () => {});
    return await requirePermission("identity:write")(c, next);
  });
  app.get("/v1/tenant/branding", async (c) => {
    const principal = requireAuth(c);
    return c.json(await readTenantBranding({ tenant_id: principal.tenant_id }, c.get("db")));
  });
  app.use(
    "/v1/tenant/branding",
    bodyLimit({
      maxSize: 6 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { code: "request_too_large", message: "Tenant branding requests may not exceed 6 MiB" },
          413,
        ),
    }),
  );
  app.put("/v1/tenant/branding", async (c) => {
    const principal = requireAuth(c);
    const parsed = TenantBrandingUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "invalid_request", message: "Invalid tenant branding request" }, 400);
    try {
      return c.json(
        await writeTenantBranding(
          {
            tenant_id: principal.tenant_id,
            actor_id: principal.id,
            actor_type: principal.kind,
            request_source: c.get("request_source") === "ui" ? "ui" : "api",
            input: parsed.data,
          },
          c.get("db"),
        ),
      );
    } catch (error) {
      if (error instanceof TenantBrandingConflictError)
        return c.json({ code: error.code, message: error.message }, 409);
      if (error instanceof BrandingImageError)
        return c.json({ code: error.code, message: error.message }, 400);
      throw error;
    }
  });
  app.delete("/v1/tenant/branding", async (c) => {
    const principal = requireAuth(c);
    const parsed = resetSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "invalid_request", message: "Invalid tenant branding request" }, 400);
    try {
      return c.json(
        tenantBrandingResponse(
          await resetTenantBranding(
            {
              tenant_id: principal.tenant_id,
              actor_id: principal.id,
              actor_type: principal.kind,
              request_source: c.get("request_source") === "ui" ? "ui" : "api",
              revision: parsed.data.revision,
            },
            c.get("db"),
          ),
          principal.tenant_id,
        ),
      );
    } catch (error) {
      if (error instanceof TenantBrandingConflictError)
        return c.json({ code: error.code, message: error.message }, 409);
      throw error;
    }
  });
  app.get("/v1/tenant/branding/logo", async (c) => {
    const principal = requireAuth(c);
    const theme = c.req.query("theme");
    const revision = Number(c.req.query("revision"));
    const context = c.req.query("tenant_context");
    if (
      (context !== undefined && context !== principal.tenant_id) ||
      (theme !== "light" && theme !== "dark") ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      return c.notFound();
    const logo = await readTenantBrandingLogo(
      { tenant_id: principal.tenant_id, theme, revision },
      c.get("db"),
    );
    if (!logo) return c.notFound();
    return new Response(Buffer.from(logo), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
