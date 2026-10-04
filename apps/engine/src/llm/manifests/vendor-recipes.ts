import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import claudeDesktop from "../../conversations/seed/vendor-recipes/claude-desktop.json" with {
  type: "json",
};
import codex from "../../conversations/seed/vendor-recipes/codex.json" with { type: "json" };
import type { Db } from "../../db/client.ts";
import { vendorRecipeOverrides } from "../../db/schema/index.ts";

export const VendorRecipeSchema = z
  .object({
    client: z.string().min(1).max(80),
    verified_at: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    transports: z.array(z.string()).min(1),
    config_path_hints: z.array(z.string()),
    config_template_streamable_http: z.record(z.string(), z.unknown()).optional(),
    config_template_stdio: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional(),
  })
  .openapi("VendorRecipe");

export type VendorRecipe = z.infer<typeof VendorRecipeSchema>;

export interface VendorRecipeFreshness {
  recipe: VendorRecipe;
  age_days: number;
  status: "fresh" | "warn" | "stale";
}

function validateRecipe(raw: unknown, source: string): VendorRecipe {
  const parsed = VendorRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `vendor-recipe ${source} is malformed: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

const RECIPES: VendorRecipe[] = [
  validateRecipe(codex, "codex.json"),
  validateRecipe(claudeDesktop, "claude-desktop.json"),
];

const WARN_DAYS = 60;
const STALE_DAYS = 90;

function normalizeClient(client: string): string {
  return client.toLowerCase().replace(/[\s_]+/g, "-");
}

export function listVendorRecipes(): ReadonlyArray<VendorRecipe> {
  return RECIPES;
}

export function getVendorRecipe(client: string): VendorRecipe | undefined {
  const norm = normalizeClient(client);
  return RECIPES.find((r) => r.client.toLowerCase() === norm);
}

export async function getVendorRecipeForTenant(
  db: Db,
  tenant_id: string,
  client: string,
): Promise<VendorRecipe | undefined> {
  const base = getVendorRecipe(client);
  if (!base) return undefined;
  const norm = normalizeClient(client);
  const rows = await db
    .select({ override: vendorRecipeOverrides.override })
    .from(vendorRecipeOverrides)
    .where(
      and(eq(vendorRecipeOverrides.tenant_id, tenant_id), eq(vendorRecipeOverrides.client, norm)),
    )
    .limit(1);
  const override = rows[0]?.override;
  if (!override) return base;
  return { ...base, ...(override as Partial<VendorRecipe>) };
}

export function recipeFreshness(
  recipe: VendorRecipe,
  now: Date = new Date(),
): VendorRecipeFreshness {
  const verifiedAt = new Date(recipe.verified_at);
  const ageMs = now.getTime() - verifiedAt.getTime();
  const age_days = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
  const status: VendorRecipeFreshness["status"] =
    age_days >= STALE_DAYS ? "stale" : age_days >= WARN_DAYS ? "warn" : "fresh";
  return { recipe, age_days, status };
}
