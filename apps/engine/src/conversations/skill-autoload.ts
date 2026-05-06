// Data-driven skill autoload.
//
// The conversation loop, the LLM context assembler, and the conversation
// boot path all need to decide which skills should land in the LLM's
// `loaded_skills` set for a given turn. This file owns that decision.
//
// Where the legacy implementation hard-coded a `RULES` array next to the
// matcher, the matcher here reads each skill's own `activates_when`
// discriminated union (see `apps/engine/src/skills/types.ts`) so the
// activation contract lives next to the skill body, not in a sibling
// table that drifts. Adding a skill no longer requires touching this
// file.
//
// Callers preload the catalog of active stable skills once per turn via
// `loadActivationCatalog(tenant_id, db)` and pass it into the matchers.
// `maturity:"experimental"` skills are excluded from autoload — they are
// only reachable via explicit `load_skill(slug)`.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { skills } from "../db/schema/index.ts";
import type { SkillActivation, SkillMaturity, SkillSideEffects } from "../skills/types.ts";

/** Slim per-skill record the matcher needs. Loaded from the `skills`
 *  table by `loadActivationCatalog`. */
export interface ActivationRecord {
  slug: string;
  activates_when: SkillActivation[];
  maturity: SkillMaturity;
  side_effects: SkillSideEffects;
  tags: string[];
}

/** Surfaces in scope for the current turn. Caller-supplied so the
 *  matcher stays pure. */
export interface ScopeFacts {
  /** Drivers of connectors currently in scope (e.g. derived from the
   *  active draft, the workflow being built, or the chat-mentioned
   *  connector). Lower-case. */
  connector_drivers?: readonly string[];
  /** Template slugs of connectors currently in scope. Lower-case. */
  connector_templates?: readonly string[];
}

export interface ToolCallContext extends ScopeFacts {
  tool: string;
  input: unknown;
}

export interface UserTurnContext extends ScopeFacts {
  /** Lower-cased user-turn text used for `intent_keyword` matching. */
  user_text: string;
  /** True when this is the conversation's first turn — `baseline`
   *  activations fire only on first-turn boot. */
  first_turn?: boolean;
}

/**
 * Load the slim activation catalog for a tenant. Returns the active,
 * non-experimental skills with their `activates_when` rules and the
 * capability/safety attributes the matcher uses for ranking and gating.
 *
 * The catalog is small — typically tens to low-hundreds of rows per
 * tenant — so we re-query per turn rather than maintaining an in-memory
 * cache that would need invalidation on skill writes. If profiling
 * later shows this is hot, an LRU keyed on `(tenant_id, max_updated_at)`
 * is the right place to add it.
 */
export async function loadActivationCatalog(
  tenant_id: string,
  db: Db,
): Promise<ActivationRecord[]> {
  const rows = await db
    .select({
      slug: skills.slug,
      activates_when: skills.activates_when,
      maturity: skills.maturity,
      side_effects: skills.side_effects,
      tags: skills.tags,
    })
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.lifecycle, "active")));
  const out: ActivationRecord[] = [];
  for (const row of rows) {
    if (row.slug === null) continue;
    if (row.maturity === "experimental") continue;
    const acts = Array.isArray(row.activates_when) ? (row.activates_when as SkillActivation[]) : [];
    out.push({
      slug: row.slug,
      activates_when: acts,
      maturity: row.maturity as SkillMaturity,
      side_effects: row.side_effects as SkillSideEffects,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    });
  }
  return out;
}

/**
 * Slugs to autoload before dispatching `tool` with `input`. Matches
 * `tool`, `tool_arg`, `connector_driver`, `connector_template`,
 * `connector_recipe_match`, and `step_kind` activation rules. Does
 * NOT consider `baseline` or `intent_keyword` rules — those are user-
 * turn signals, not tool-call signals.
 */
export function autoloadForToolCall(
  ctx: ToolCallContext,
  catalog: readonly ActivationRecord[],
  currently_loaded: readonly string[],
): string[] {
  const have = new Set(currently_loaded);
  const out = new Set<string>();
  const drivers = new Set((ctx.connector_drivers ?? []).map((d) => d.toLowerCase()));
  const templates = new Set((ctx.connector_templates ?? []).map((t) => t.toLowerCase()));
  // build_workflow has a steps array; each step's connector_id resolves
  // to a driver elsewhere, but operators may have set
  // step.config.driver inline. Surface those drivers too — preserves
  // the legacy build_workflow → s3-connectors / postgres-connectors /
  // graphql-connectors behavior even when ScopeFacts didn't include
  // them upstream.
  for (const d of inferDriversFromToolInput(ctx.tool, ctx.input)) drivers.add(d.toLowerCase());
  const stepKinds = new Set(inferStepKindsFromToolInput(ctx.tool, ctx.input));

  for (const rec of catalog) {
    if (have.has(rec.slug)) continue;
    if (out.has(rec.slug)) continue;
    // Defense in depth — `loadActivationCatalog` already drops
    // experimental skills, but a hand-built catalog (eg. unit tests,
    // tenant overrides) might leak one through. Experimental skills
    // are only loadable via explicit `load_skill(slug)`.
    if (rec.maturity === "experimental") continue;
    if (matchesToolCall(rec.activates_when, ctx, drivers, templates, stepKinds)) {
      out.add(rec.slug);
    }
  }
  return rankAndOrder(out, catalog);
}

/**
 * Slugs to autoload at user-turn time. Matches `baseline` (only on
 * first turn) and `intent_keyword` (always). Connector scope feeds
 * `connector_driver` and `connector_template` rules — the LLM should
 * see e.g. `postgres-connectors` the moment the user asks about a
 * connector with that driver, not only after `propose_step` fires.
 */
export function autoloadForUserTurn(
  ctx: UserTurnContext,
  catalog: readonly ActivationRecord[],
  currently_loaded: readonly string[],
): string[] {
  const have = new Set(currently_loaded);
  const out = new Set<string>();
  const text = (ctx.user_text ?? "").toLowerCase();
  const drivers = new Set((ctx.connector_drivers ?? []).map((d) => d.toLowerCase()));
  const templates = new Set((ctx.connector_templates ?? []).map((t) => t.toLowerCase()));

  for (const rec of catalog) {
    if (have.has(rec.slug)) continue;
    if (out.has(rec.slug)) continue;
    if (rec.maturity === "experimental") continue;
    if (matchesUserTurn(rec.activates_when, text, drivers, templates, ctx.first_turn === true)) {
      out.add(rec.slug);
    }
  }
  return rankAndOrder(out, catalog);
}

/**
 * Slugs to load on conversation boot. These are the skills with at
 * least one `kind:"baseline"` activation rule. Used by
 * `conversations/service.ts` when seeding `loaded_skills` on first
 * insert.
 */
export function listBaselineSlugs(catalog: readonly ActivationRecord[]): string[] {
  const out: string[] = [];
  for (const rec of catalog) {
    if (rec.activates_when.some((r) => r.kind === "baseline")) out.push(rec.slug);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------

function matchesToolCall(
  rules: readonly SkillActivation[],
  ctx: ToolCallContext,
  drivers: Set<string>,
  templates: Set<string>,
  stepKinds: Set<string>,
): boolean {
  for (const rule of rules) {
    switch (rule.kind) {
      case "tool":
        if (rule.tool === ctx.tool) return true;
        break;
      case "tool_arg":
        if (rule.tool === ctx.tool && evaluatePath(ctx.input, rule.path, rule.equals)) return true;
        break;
      case "connector_driver":
        if (drivers.has(rule.driver.toLowerCase())) return true;
        break;
      case "connector_template":
        if (templates.has(rule.slug.toLowerCase())) return true;
        break;
      case "connector_recipe_match":
        if (templates.has(rule.template.toLowerCase())) return true;
        break;
      case "step_kind":
        if (rule.step_kinds.some((k) => stepKinds.has(k))) return true;
        break;
      // baseline + intent_keyword are not relevant to tool-call autoload.
      case "baseline":
      case "intent_keyword":
        break;
    }
  }
  return false;
}

function matchesUserTurn(
  rules: readonly SkillActivation[],
  text: string,
  drivers: Set<string>,
  templates: Set<string>,
  first_turn: boolean,
): boolean {
  for (const rule of rules) {
    switch (rule.kind) {
      case "baseline":
        if (first_turn) return true;
        break;
      case "intent_keyword":
        if (text.includes(rule.word.toLowerCase())) return true;
        break;
      case "connector_driver":
        if (drivers.has(rule.driver.toLowerCase())) return true;
        break;
      case "connector_template":
        if (templates.has(rule.slug.toLowerCase())) return true;
        break;
      case "connector_recipe_match":
        if (templates.has(rule.template.toLowerCase())) return true;
        break;
      // tool / tool_arg / step_kind are not relevant to user-turn autoload —
      // they only fire on tool-call signals.
      case "tool":
      case "tool_arg":
      case "step_kind":
        break;
    }
  }
  return false;
}

/**
 * Walk a dot-path against an unknown shape. Supports two segment
 * meta-tokens:
 *   - `*` or `[*]`: iterate over an array (any-match semantics)
 *   - all other segments are property keys on the current object
 *
 * Returns true when at least one resolved value is `=== equals`.
 */
function evaluatePath(input: unknown, path: string, equals: string | number | boolean): boolean {
  const segments = path
    .split(".")
    .flatMap((p) => (p.endsWith("[*]") ? [p.slice(0, -3), "*"] : [p]));
  return walk(input, segments, 0, equals);
}

function walk(
  value: unknown,
  segs: readonly string[],
  i: number,
  equals: string | number | boolean,
): boolean {
  if (i === segs.length) return value === equals;
  const seg = segs[i]!;
  if (seg === "*") {
    if (!Array.isArray(value)) return false;
    return value.some((v) => walk(v, segs, i + 1, equals));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const next = (value as Record<string, unknown>)[seg];
  if (next === undefined) return false;
  return walk(next, segs, i + 1, equals);
}

/**
 * Inspect a tool-call input for inline driver hints. Mirrors the
 * legacy RULES table behavior on `propose_step` and `build_workflow`
 * without forcing every caller to threadthe driver list through
 * ScopeFacts. Only inspects shapes the matcher knows about — unknown
 * shapes return an empty list (they fall back to ScopeFacts).
 */
function inferDriversFromToolInput(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  if (tool === "propose_step") {
    const step = pickObject((input as Record<string, unknown>).step ?? input);
    const cfg = pickObject(step.config);
    const drivers: string[] = [];
    if (typeof cfg.driver === "string") drivers.push(cfg.driver);
    if (typeof step.driver === "string") drivers.push(step.driver as string);
    if (step.graphql !== undefined) drivers.push("graphql");
    return drivers;
  }
  if (tool === "build_workflow") {
    const stepsRaw = (input as Record<string, unknown>).steps;
    if (!Array.isArray(stepsRaw)) return [];
    const drivers: string[] = [];
    for (const raw of stepsRaw) {
      const step = pickObject(raw);
      const cfg = pickObject(step.config);
      if (typeof cfg.driver === "string") drivers.push(cfg.driver);
      if (typeof step.driver === "string") drivers.push(step.driver as string);
      if (step.graphql !== undefined) drivers.push("graphql");
    }
    return drivers;
  }
  return [];
}

function pickObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Inspect a tool-call input for step-kind hints. Mirrors the
 * driver-inference path but extracts `step.kind` from `propose_step`
 * and the recursive shape of `build_workflow.steps[*]` (including
 * branches / loops / parallel sub-steps). Skills with a `step_kind`
 * activation rule auto-load when the LLM is currently authoring a
 * workflow that uses the named primitive.
 */
function inferStepKindsFromToolInput(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  const visit = (raw: unknown): void => {
    const step = pickObject(raw);
    if (typeof step.kind === "string") out.push(step.kind);
    if (Array.isArray(step.then_steps)) for (const s of step.then_steps) visit(s);
    if (Array.isArray(step.else_steps)) for (const s of step.else_steps) visit(s);
    if (Array.isArray(step.branches))
      for (const branch of step.branches) {
        if (Array.isArray(branch)) for (const s of branch) visit(s);
      }
    if (Array.isArray(step.body_steps)) for (const s of step.body_steps) visit(s);
  };
  if (tool === "propose_step") {
    visit((input as Record<string, unknown>).step ?? input);
    return out;
  }
  if (tool === "build_workflow" || tool === "edit_workflow_patch") {
    const stepsRaw = (input as Record<string, unknown>).steps;
    if (Array.isArray(stepsRaw)) for (const raw of stepsRaw) visit(raw);
    // edit_workflow_patch may carry adds/removes under different keys.
    const adds = (input as Record<string, unknown>).step_adds;
    if (Array.isArray(adds)) for (const raw of adds) visit(raw);
    return out;
  }
  return out;
}

/**
 * Rank matched slugs deterministically. Skills with more `tags` rank
 * first (more specific = more relevant), tied by lexicographic slug
 * order so the same matcher input always produces the same output —
 * pinned by the parity matrix in skill-autoload.test.ts.
 */
function rankAndOrder(slugs: Set<string>, catalog: readonly ActivationRecord[]): string[] {
  const tagCount = new Map<string, number>();
  for (const rec of catalog) tagCount.set(rec.slug, rec.tags.length);
  return [...slugs].sort((a, b) => {
    const ta = tagCount.get(a) ?? 0;
    const tb = tagCount.get(b) ?? 0;
    if (ta !== tb) return tb - ta;
    return a.localeCompare(b);
  });
}
