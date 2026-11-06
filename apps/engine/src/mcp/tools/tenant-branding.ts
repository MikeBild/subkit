import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  assertTenantBrandingWrite,
  BrandingImageError,
  normalizeTenantBrandingImage,
  readTenantBranding,
  readTenantBrandingLogo,
  resetTenantBranding,
  TenantBrandingConflictError,
  TenantBrandingLogoReadSchema,
  TenantBrandingPermissionError,
  TenantBrandingResetSchema,
  TenantBrandingUpdateSchema,
  tenantBrandingResponse,
  writeTenantBranding,
} from "../../identity/index.ts";

export const GET_TENANT_BRANDING_TOOL_NAME = "get_tenant_branding";
export const UPDATE_TENANT_BRANDING_TOOL_NAME = "update_tenant_branding";
export const RESET_TENANT_BRANDING_TOOL_NAME = "reset_tenant_branding";
export const GET_TENANT_BRANDING_LOGO_TOOL_NAME = "get_tenant_branding_logo";

function mcpSchema(schema: z.ZodType): Tool["inputSchema"] {
  const { $schema: _, ...json } = z.toJSONSchema(schema);
  return json as Tool["inputSchema"];
}

export const getTenantBrandingMcpTool: Tool = {
  name: GET_TENANT_BRANDING_TOOL_NAME,
  description:
    "Read the current workspace branding metadata. This does not include logo bytes; use get_tenant_branding_logo for one normalized logo.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const updateTenantBrandingMcpTool: Tool = {
  name: UPDATE_TENANT_BRANDING_TOOL_NAME,
  description:
    "Save workspace branding with an optimistic revision. Replaced logos use PNG, JPEG or WebP base64 input and are normalized to still PNG before storage.",
  inputSchema: mcpSchema(TenantBrandingUpdateSchema),
};

export const resetTenantBrandingMcpTool: Tool = {
  name: RESET_TENANT_BRANDING_TOOL_NAME,
  description:
    "Reset workspace branding to the product defaults with an optimistic revision. The revision remains monotonic.",
  inputSchema: mcpSchema(TenantBrandingResetSchema),
};

export const getTenantBrandingLogoMcpTool: Tool = {
  name: GET_TENANT_BRANDING_LOGO_TOOL_NAME,
  description:
    "Read one normalized current-revision workspace logo as PNG base64. Returns not_found when the logo, theme or revision is unavailable.",
  inputSchema: mcpSchema(TenantBrandingLogoReadSchema),
};

type ToolFailure = { ok: false; data: { error_code: string; message: string } };
type ApprovalArgsPreparation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error_code: string; message: string };

function invalidArguments(error: z.ZodError): ToolFailure {
  const issue = error.issues[0];
  return {
    ok: false,
    data: {
      error_code: "invalid_arguments",
      message: issue
        ? `invalid arguments${issue.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue.message}`
        : "invalid arguments",
    },
  };
}

function failure(error: unknown): ToolFailure {
  if (error instanceof TenantBrandingConflictError)
    return { ok: false, data: { error_code: error.code, message: error.message } };
  if (error instanceof BrandingImageError)
    return { ok: false, data: { error_code: error.code, message: error.message } };
  if (error instanceof TenantBrandingPermissionError)
    return { ok: false, data: { error_code: error.code, message: error.message } };
  throw error;
}

export async function prepareTenantBrandingApprovalArgs(
  rawArgs: Record<string, unknown>,
): Promise<ApprovalArgsPreparation> {
  const parsed = TenantBrandingUpdateSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const result = invalidArguments(parsed.error);
    return { ok: false, ...result.data };
  }
  try {
    const normalize = async (operation: typeof parsed.data.logos.light) => {
      if (operation.operation !== "replace") return operation;
      const bytes = await normalizeTenantBrandingImage(operation);
      return {
        operation: "replace" as const,
        mime_type: "image/png" as const,
        content_base64: Buffer.from(bytes).toString("base64"),
      };
    };
    return {
      ok: true,
      args: {
        ...parsed.data,
        logos: {
          light: await normalize(parsed.data.logos.light),
          dark: await normalize(parsed.data.logos.dark),
        },
      },
    };
  } catch (error) {
    const result = failure(error);
    return { ok: false, ...result.data };
  }
}

type Ctx = { db: Db; principal: ResolvedPrincipal };

export async function handleGetTenantBranding(ctx: Ctx) {
  return {
    ok: true as const,
    data: await readTenantBranding({ tenant_id: ctx.principal.tenant_id }, ctx.db),
  };
}

export async function handleGetTenantBrandingLogo(ctx: Ctx, rawArgs: unknown) {
  const parsed = TenantBrandingLogoReadSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments(parsed.error);
  const logo = await readTenantBrandingLogo(
    { tenant_id: ctx.principal.tenant_id, ...parsed.data },
    ctx.db,
  );
  if (!logo)
    return {
      ok: false as const,
      data: {
        error_code: "not_found",
        message: "branding logo is unavailable for this theme or revision",
      },
    };
  return {
    ok: true as const,
    data: { mime_type: "image/png", content_base64: Buffer.from(logo).toString("base64") },
  };
}

export async function handleUpdateTenantBranding(ctx: Ctx, rawArgs: unknown) {
  const parsed = TenantBrandingUpdateSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments(parsed.error);
  try {
    await assertTenantBrandingWrite(ctx.principal, ctx.db);
    return {
      ok: true as const,
      data: await writeTenantBranding(
        {
          tenant_id: ctx.principal.tenant_id,
          actor_id: ctx.principal.id,
          actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
          request_source: "mcp",
          input: parsed.data,
        },
        ctx.db,
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function handleResetTenantBranding(ctx: Ctx, rawArgs: unknown) {
  const parsed = TenantBrandingResetSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments(parsed.error);
  try {
    await assertTenantBrandingWrite(ctx.principal, ctx.db);
    return {
      ok: true as const,
      data: tenantBrandingResponse(
        await resetTenantBranding(
          {
            tenant_id: ctx.principal.tenant_id,
            actor_id: ctx.principal.id,
            actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
            request_source: "mcp",
            revision: parsed.data.revision,
          },
          ctx.db,
        ),
        ctx.principal.tenant_id,
      ),
    };
  } catch (error) {
    return failure(error);
  }
}
