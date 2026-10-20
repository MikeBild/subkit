import { type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { browserSessionForPrincipal } from "../../auth/index.ts";
import {
  BrandingImageError,
  getTenantBranding,
  getTenantBrandingLogo,
  normalizeTenantBrandingImage,
  resetTenantBranding,
  TenantBrandingConflictError,
  updateTenantBranding,
} from "../../identity/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const text = z.string().trim().max(80).nullable();
const subtitle = z.string().trim().max(160).nullable();
const operation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("keep") }).strict(),
  z.object({ operation: z.literal("remove") }).strict(),
  z
    .object({
      operation: z.literal("replace"),
      mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
      content_base64: z.string().min(1),
    })
    .strict(),
]);
export const TenantBrandingUpdate = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    display_name: text,
    subtitle,
    palette: z.enum(["standard", "indigo", "teal"]).nullable(),
    logos: z.object({ light: operation, dark: operation }).strict(),
  })
  .strict()
  .openapi("TenantBrandingUpdate");
export const TenantBrandingResponse = z
  .object({
    configured: z.boolean(),
    revision: z.number().int(),
    display_name: z.string().nullable(),
    subtitle: z.string().nullable(),
    palette: z.enum(["standard", "indigo", "teal"]).nullable(),
    logos: z.object({ light: z.boolean(), dark: z.boolean() }),
    logo_urls: z.object({ light: z.string().nullable(), dark: z.string().nullable() }),
  })
  .openapi("TenantBrandingResponse");
const updateSchema = TenantBrandingUpdate;
const resetSchema = z
  .object({ revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
  .strict();

async function browserPrincipal(c: Context<AppEnv>) {
  const principal = requireAuth(c);
  if (principal.kind !== "user" || !(await browserSessionForPrincipal(c.req.raw, principal)))
    return null;
  return principal;
}

function brandingResponse(value: Awaited<ReturnType<typeof getTenantBranding>>, tenantId: string) {
  const query = new URLSearchParams({ tenant_context: tenantId, revision: String(value.revision) });
  return {
    ...value,
    logo_urls: {
      light: value.logos.light ? `/v1/tenant/branding/logo?theme=light&${query}` : null,
      dark: value.logos.dark ? `/v1/tenant/branding/logo?theme=dark&${query}` : null,
    },
  };
}

export function registerTenantBrandingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/tenant/branding/logo",
    operationId: "getTenantBrandingLogo",
    tags: ["identity"],
    security: [{ browserSession: [] }],
    request: {
      query: z.object({
        theme: z.enum(["light", "dark"]),
        revision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        tenant_context: z.string().uuid(),
      }),
    },
    responses: {
      200: {
        description: "Normalized logo for the current workspace and revision",
        content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } },
      },
      401: { description: "Browser session required" },
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
    401: { description: "Browser session required" },
    403: { description: "Permission denied" },
    409: { description: "Concurrent update" },
    413: { description: "Request too large" },
  };
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/tenant/branding",
    operationId: "getTenantBranding",
    tags: ["identity"],
    security: [{ browserSession: [] }],
    responses,
  });
  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/v1/tenant/branding",
    operationId: "updateTenantBranding",
    tags: ["identity"],
    security: [{ browserSession: [] }],
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
    security: [{ browserSession: [] }],
    request: { body: { required: true, content: { "application/json": { schema: resetSchema } } } },
    responses,
  });
  app.use("/v1/tenant/branding", async (c, next) => {
    if (c.req.method === "GET") return await next();
    await requirePermission("settings:write")(c, async () => {});
    return await requirePermission("identity:write")(c, next);
  });
  app.get("/v1/tenant/branding", async (c) => {
    const principal = await browserPrincipal(c);
    if (!principal)
      return c.json({ code: "browser_session_required", message: "browser session required" }, 401);
    return c.json(
      brandingResponse(
        await getTenantBranding(principal.tenant_id, c.get("db")),
        principal.tenant_id,
      ),
    );
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
    const principal = await browserPrincipal(c);
    if (!principal)
      return c.json({ code: "browser_session_required", message: "browser session required" }, 401);
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "invalid_request", message: "Invalid tenant branding request" }, 400);
    try {
      const toBytes = async (value: z.infer<typeof operation>) =>
        value.operation === "replace"
          ? await normalizeTenantBrandingImage(value)
          : value.operation === "remove"
            ? null
            : undefined;
      const value = await updateTenantBranding(
        {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          revision: parsed.data.revision,
          display_name: parsed.data.display_name,
          subtitle: parsed.data.subtitle,
          palette: parsed.data.palette,
          logo_light: await toBytes(parsed.data.logos.light),
          logo_dark: await toBytes(parsed.data.logos.dark),
        },
        c.get("db"),
      );
      return c.json(brandingResponse(value, principal.tenant_id));
    } catch (error) {
      if (error instanceof TenantBrandingConflictError)
        return c.json({ code: error.code, message: error.message }, 409);
      if (error instanceof BrandingImageError)
        return c.json({ code: error.code, message: error.message }, 400);
      throw error;
    }
  });
  app.delete("/v1/tenant/branding", async (c) => {
    const principal = await browserPrincipal(c);
    if (!principal)
      return c.json({ code: "browser_session_required", message: "browser session required" }, 401);
    const parsed = resetSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "invalid_request", message: "Invalid tenant branding request" }, 400);
    try {
      return c.json(
        brandingResponse(
          await resetTenantBranding(
            {
              tenant_id: principal.tenant_id,
              actor_id: principal.id,
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
    const principal = await browserPrincipal(c);
    const theme = c.req.query("theme");
    const revision = Number(c.req.query("revision"));
    const context = c.req.query("tenant_context");
    if (
      !principal ||
      context !== principal.tenant_id ||
      (theme !== "light" && theme !== "dark") ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      return c.notFound();
    const logo = await getTenantBrandingLogo(principal.tenant_id, theme, revision, c.get("db"));
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
