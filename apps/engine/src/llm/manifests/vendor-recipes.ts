// VendorRecipeManifest — hand-curated, version-checked MCP client
// configs.
//
// The manifest is the *only* source the assistant should quote when
// asked to produce a config block for Codex / Claude Desktop / etc.
// Every entry carries a `verified_at` date so operators can spot
// stale recipes (warn at 60 days, error at 90).
//
// Files live under `apps/engine/src/conversations/seed/vendor-recipes/`
// and are loaded once at module import time. They are intentionally
// JSON (not Markdown like Skills) so the recipe-gate scanner can
// structurally compare assistant output against the canonical shape.
//
// Per-tenant overrides: `getVendorRecipeForTenant(db, tenant_id, client)`
// shallow-merges rows from `vendor_recipe_overrides` over the base entry.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import claudeDesktop from "../../conversations/seed/vendor-recipes/claude-desktop.json" with { type: "json" };
import codex from "../../conversations/seed/vendor-recipes/codex.json" with { type: "json" };
import type { Db } from "../../db/client.ts";
import { vendorRecipeOverrides } from "../../db/schema/index.ts";

/**
 * Zod schema for a single vendor-recipe JSON document. Every JSON file
 * under `apps/engine/src/conversations/seed/vendor-recipes/` is validated
 * against this shape at engine start; a malformed or drifted recipe
 * fails the boot rather than silently shipping bad config to the model.
 */
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

/** All verified vendor recipes, in declaration order. */
export function listVendorRecipes(): ReadonlyArray<VendorRecipe> {
  return RECIPES;
}

/** Look up a recipe by client id (case-insensitive, hyphen/space tolerant). */
export function getVendorRecipe(client: string): VendorRecipe | undefined {
  const norm = normalizeClient(client);
  return RECIPES.find((r) => r.client.toLowerCase() === norm);
}

/**
 * Resolve a recipe with optional per-tenant overrides merged over the manifest.
 * Falls back to the base recipe when no override row exists.
 */
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

/**
 * Return freshness for a single recipe. Used by
 * `manifests/tests/vendor-recipes.test.ts` to fail CI when verifications
 * lapse. `now` is injectable so tests are deterministic.
 */
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
