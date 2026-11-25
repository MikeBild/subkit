import type { z } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { can } from "../rbac/index.ts";
import {
  getTenantBranding,
  getTenantBrandingAppIcon,
  getTenantBrandingLogo,
  normalizeTenantBrandingAppIcon,
  normalizeTenantBrandingImage,
  updateTenantBranding,
} from "./tenant-branding.ts";
import { TenantBrandingUpdateSchema, tenantBrandingResponse } from "./tenant-branding-contract.ts";

export class TenantBrandingPermissionError extends Error {
  readonly code = "forbidden";
  constructor(readonly permission: string) {
    super(`Permission required: ${permission}`);
  }
}

export async function assertTenantBrandingWrite(principal: ResolvedPrincipal, db: Db) {
  for (const permission of ["settings:write", "identity:write"]) {
    const decision = await can(db, { tenant_id: principal.tenant_id, principal, permission });
    if (!decision.allow) throw new TenantBrandingPermissionError(permission);
  }
}

export async function readTenantBranding(input: { tenant_id: string }, db: Executor) {
  return tenantBrandingResponse(await getTenantBranding(input.tenant_id, db), input.tenant_id);
}

export async function writeTenantBranding(
  input: {
    tenant_id: string;
    actor_id: string;
    actor_type?: "user" | "system_account";
    request_source?: "api" | "cli" | "mcp" | "ui";
    input: z.infer<typeof TenantBrandingUpdateSchema>;
  },
  db: Executor,
) {
  const value = TenantBrandingUpdateSchema.parse(input.input);
  async function logo(operation: typeof value.logos.light) {
    return operation.operation === "replace"
      ? await normalizeTenantBrandingImage(operation)
      : operation.operation === "remove"
        ? null
        : undefined;
  }
  const appIcon = value.app_icon;
  const saved = await updateTenantBranding(
    {
      tenant_id: input.tenant_id,
      actor_id: input.actor_id,
      ...(input.actor_type ? { actor_type: input.actor_type } : {}),
      ...(input.request_source ? { request_source: input.request_source } : {}),
      revision: value.revision,
      ...(value.display_name === undefined ? {} : { display_name: value.display_name }),
      subtitle: value.subtitle,
      palette: value.palette,
      logo_light: await logo(value.logos.light),
      logo_dark: await logo(value.logos.dark),
      app_icon:
        appIcon?.operation === "replace"
          ? await normalizeTenantBrandingAppIcon(appIcon)
          : appIcon?.operation === "remove"
            ? null
            : undefined,
    },
    db,
  );
  return tenantBrandingResponse(saved, input.tenant_id);
}

export async function readTenantBrandingLogo(
  input: {
    tenant_id: string;
    theme: "light" | "dark";
    revision: number;
  },
  db: Executor,
) {
  return await getTenantBrandingLogo(input.tenant_id, input.theme, input.revision, db);
}

export async function readTenantBrandingAppIcon(
  input: {
    tenant_id: string;
    revision: number;
    size: 192 | 512;
  },
  db: Executor,
) {
  return await getTenantBrandingAppIcon(input.tenant_id, input.revision, input.size, db);
}
