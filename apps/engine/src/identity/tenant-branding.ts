import { and, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { tenantBranding, tenants } from "../db/schema/index.ts";
import {
  type BRANDING_APP_ICON_SIZES,
  normalizeBrandingAppIcon,
  normalizeBrandingImage,
} from "../files/branding-image.ts";

export { BrandingImageError } from "../files/branding-image.ts";

export const BRANDING_PALETTES = ["standard", "indigo", "teal"] as const;
export type BrandingPalette = (typeof BRANDING_PALETTES)[number];

export class TenantBrandingConflictError extends Error {
  readonly code = "tenant_branding_conflict";
  constructor() {
    super("Tenant branding has changed. Reload and try again.");
    this.name = "TenantBrandingConflictError";
  }
}

export interface TenantBrandingValue {
  configured: boolean;
  revision: number;
  display_name: string | null;
  subtitle: string | null;
  palette: BrandingPalette | null;
  logos: { light: boolean; dark: boolean };
  app_icon: boolean;
}

export interface TenantBrandingUpdate {
  revision: number;
  display_name: string | null;
  subtitle: string | null;
  palette: BrandingPalette | null;
  logo_light: Uint8Array | null | undefined;
  logo_dark: Uint8Array | null | undefined;
  app_icon: { icon_192: Uint8Array; icon_512: Uint8Array } | null | undefined;
}

function present(row: typeof tenantBranding.$inferSelect | undefined): TenantBrandingValue {
  const configured =
    !!row &&
    (row.display_name !== null ||
      row.subtitle !== null ||
      row.palette !== null ||
      row.logo_light !== null ||
      row.logo_dark !== null ||
      row.app_icon_192 !== null ||
      row.app_icon_512 !== null);
  return row
    ? {
        configured,
        revision: row.revision,
        display_name: row.display_name,
        subtitle: row.subtitle,
        palette: row.palette,
        logos: { light: row.logo_light !== null, dark: row.logo_dark !== null },
        app_icon: row.app_icon_192 !== null && row.app_icon_512 !== null,
      }
    : {
        configured: false,
        revision: 0,
        display_name: null,
        subtitle: null,
        palette: null,
        logos: { light: false, dark: false },
        app_icon: false,
      };
}

export async function normalizeTenantBrandingImage(input: {
  mime_type: string;
  content_base64: string;
}): Promise<Uint8Array> {
  return await normalizeBrandingImage(input);
}

export async function getTenantBranding(
  tenantId: string,
  db: Executor,
): Promise<TenantBrandingValue> {
  const [row] = await db
    .select({
      revision: tenantBranding.revision,
      display_name: tenantBranding.display_name,
      subtitle: tenantBranding.subtitle,
      palette: tenantBranding.palette,
      logo_light: sql<boolean>`${tenantBranding.logo_light} IS NOT NULL`,
      logo_dark: sql<boolean>`${tenantBranding.logo_dark} IS NOT NULL`,
      app_icon: sql<boolean>`${tenantBranding.app_icon_192} IS NOT NULL AND ${tenantBranding.app_icon_512} IS NOT NULL`,
    })
    .from(tenantBranding)
    .where(eq(tenantBranding.tenant_id, tenantId))
    .limit(1);
  return row
    ? {
        configured:
          row.display_name !== null ||
          row.subtitle !== null ||
          row.palette !== null ||
          row.logo_light ||
          row.logo_dark ||
          row.app_icon,
        revision: row.revision,
        display_name: row.display_name,
        subtitle: row.subtitle,
        palette: row.palette,
        logos: { light: row.logo_light, dark: row.logo_dark },
        app_icon: row.app_icon,
      }
    : present(undefined);
}

export async function getTenantBrandingLogo(
  tenantId: string,
  theme: "light" | "dark",
  revision: number,
  db: Executor,
): Promise<Uint8Array | null> {
  const [row] = await db
    .select({
      revision: tenantBranding.revision,
      logo:
        theme === "light"
          ? sql<Uint8Array | null>`coalesce(${tenantBranding.logo_light}, ${tenantBranding.logo_dark})`
          : sql<Uint8Array | null>`coalesce(${tenantBranding.logo_dark}, ${tenantBranding.logo_light})`,
    })
    .from(tenantBranding)
    .where(eq(tenantBranding.tenant_id, tenantId))
    .limit(1);
  if (!row || row.revision !== revision) return null;
  return row.logo;
}

export async function getTenantBrandingAppIcon(
  tenantId: string,
  revision: number,
  size: (typeof BRANDING_APP_ICON_SIZES)[number],
  db: Executor,
): Promise<Uint8Array | null> {
  const [row] = await db
    .select({
      revision: tenantBranding.revision,
      icon: size === 192 ? tenantBranding.app_icon_192 : tenantBranding.app_icon_512,
    })
    .from(tenantBranding)
    .where(eq(tenantBranding.tenant_id, tenantId))
    .limit(1);
  if (!row || row.revision !== revision) return null;
  return row.icon;
}

export async function updateTenantBranding(
  input: TenantBrandingUpdate & {
    tenant_id: string;
    actor_id: string;
    actor_type?: "user" | "system_account";
    request_source?: "api" | "cli" | "mcp" | "ui";
  },
  db: Executor,
): Promise<TenantBrandingValue> {
  return await db.transaction(async (tx) => {
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenant_id))
      .for("update")
      .limit(1);
    const [current] = await tx
      .select()
      .from(tenantBranding)
      .where(eq(tenantBranding.tenant_id, input.tenant_id))
      .limit(1);
    if ((current?.revision ?? 0) !== input.revision) throw new TenantBrandingConflictError();
    const values = {
      display_name: input.display_name,
      subtitle: input.subtitle,
      palette: input.palette,
      logo_light: input.logo_light === undefined ? (current?.logo_light ?? null) : input.logo_light,
      logo_dark: input.logo_dark === undefined ? (current?.logo_dark ?? null) : input.logo_dark,
      app_icon_192:
        input.app_icon === undefined
          ? (current?.app_icon_192 ?? null)
          : (input.app_icon?.icon_192 ?? null),
      app_icon_512:
        input.app_icon === undefined
          ? (current?.app_icon_512 ?? null)
          : (input.app_icon?.icon_512 ?? null),
      revision: input.revision + 1,
      updated_at: new Date(),
    };
    const [row] = current
      ? await tx
          .update(tenantBranding)
          .set(values)
          .where(
            and(
              eq(tenantBranding.tenant_id, input.tenant_id),
              eq(tenantBranding.revision, input.revision),
            ),
          )
          .returning()
      : await tx
          .insert(tenantBranding)
          .values({ tenant_id: input.tenant_id, ...values })
          .returning();
    if (!row) throw new TenantBrandingConflictError();
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_type ?? "user",
        actor_id: input.actor_id,
        action: AuditAction.TENANT_UPDATED,
        resource_type: "tenant_branding",
        resource_id: input.tenant_id,
        result: "success",
        metadata: {
          source: input.request_source ?? "ui",
          request_source: input.request_source ?? "ui",
          revision: row.revision,
          before: present(current),
          after: present(row),
          logo_light_bytes: row.logo_light?.length ?? 0,
          logo_dark_bytes: row.logo_dark?.length ?? 0,
          app_icon_192_bytes: row.app_icon_192?.length ?? 0,
          app_icon_512_bytes: row.app_icon_512?.length ?? 0,
        },
      },
      tx,
    );
    return present(row);
  });
}

export async function resetTenantBranding(
  input: {
    tenant_id: string;
    revision: number;
    actor_id: string;
    actor_type?: "user" | "system_account";
    request_source?: "api" | "cli" | "mcp" | "ui";
  },
  db: Executor,
): Promise<TenantBrandingValue> {
  return await updateTenantBranding(
    {
      ...input,
      display_name: null,
      subtitle: null,
      palette: null,
      logo_light: null,
      logo_dark: null,
      app_icon: null,
    },
    db,
  );
}

export async function normalizeTenantBrandingAppIcon(input: {
  mime_type: string;
  content_base64: string;
}): Promise<{ icon_192: Uint8Array; icon_512: Uint8Array }> {
  return await normalizeBrandingAppIcon(input);
}
