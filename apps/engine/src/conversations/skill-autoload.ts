import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { skills } from "../db/schema/index.ts";
import {
  type SkillActivation,
  type SkillAppliesTo,
  type SkillAudience,
  type SkillMaturity,
  type SkillSideEffects,
  skillOfferedTo,
} from "../skills/types.ts";

export interface ActivationRecord {
  slug: string;
  activates_when: SkillActivation[];
  maturity: SkillMaturity;
  side_effects: SkillSideEffects;
  tags: string[];
  applies_to?: SkillAppliesTo;
}

export interface ScopeFacts {
  connector_drivers?: readonly string[];
  connector_templates?: readonly string[];
  audience?: SkillAudience | undefined;
}

export interface ToolCallContext extends ScopeFacts {
  tool: string;
  input: unknown;
}

export interface UserTurnContext extends ScopeFacts {
  user_text: string;
  first_turn?: boolean;
  surface?: string | undefined;
}

export const AUTHORING_ONLY_TAG = "authoring-only";

function notOffered(rec: ActivationRecord, audience: SkillAudience | undefined): boolean {
  return audience !== undefined && !skillOfferedTo(rec.applies_to ?? "both", audience);
}

function suppressedOnSurface(rec: ActivationRecord, surface: string | undefined): boolean {
  return surface === "chat" && rec.tags.includes(AUTHORING_ONLY_TAG);
}

export async function loadActivationCatalog(
  tenant_id: string,
  db: Db,
): Promise<ActivationRecord[]> {
  const rows = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      activates_when: skills.activates_when,
      maturity: skills.maturity,
      side_effects: skills.side_effects,
      tags: skills.tags,
      applies_to: skills.applies_to,
    })
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.lifecycle, "active")));
  const out: ActivationRecord[] = [];
  for (const row of rows) {
    if (row.maturity === "experimental") continue;
    const acts = Array.isArray(row.activates_when) ? (row.activates_when as SkillActivation[]) : [];
    out.push({
      slug: row.slug ?? row.id,
      activates_when: acts,
      maturity: row.maturity as SkillMaturity,
      side_effects: row.side_effects as SkillSideEffects,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      applies_to: row.applies_to,
    });
  }
  return out;
}

export function autoloadForToolCall(
  ctx: ToolCallContext,
  catalog: readonly ActivationRecord[],
  currently_loaded: readonly string[],
): string[] {
  const have = new Set(currently_loaded);
  const out = new Set<string>();
  const drivers = new Set((ctx.connector_drivers ?? []).map((d) => d.toLowerCase()));
  const templates = new Set((ctx.connector_templates ?? []).map((t) => t.toLowerCase()));
  for (const d of inferDriversFromToolInput(ctx.tool, ctx.input)) drivers.add(d.toLowerCase());
  const stepKinds = new Set(inferStepKindsFromToolInput(ctx.tool, ctx.input));

  for (const rec of catalog) {
    if (have.has(rec.slug)) continue;
    if (out.has(rec.slug)) continue;
    if (rec.maturity === "experimental") continue;
    if (notOffered(rec, ctx.audience)) continue;
    if (matchesToolCall(rec.activates_when, ctx, drivers, templates, stepKinds)) {
      out.add(rec.slug);
    }
  }
  return rankAndOrder(out, catalog);
}

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
    if (suppressedOnSurface(rec, ctx.surface)) continue;
    if (notOffered(rec, ctx.audience)) continue;
    if (matchesUserTurn(rec.activates_when, text, drivers, templates, ctx.first_turn === true)) {
      out.add(rec.slug);
    }
  }
  return rankAndOrder(out, catalog);
}

export function reaffirmLoadedForTurn(
  ctx: (UserTurnContext & { mode: "user_turn" }) | (ToolCallContext & { mode: "tool_call" }),
  catalog: readonly ActivationRecord[],
  currently_loaded: readonly string[],
): string[] {
  const loaded = new Set(currently_loaded);
  const out = new Set<string>();
  const drivers = new Set((ctx.connector_drivers ?? []).map((d) => d.toLowerCase()));
  const templates = new Set((ctx.connector_templates ?? []).map((t) => t.toLowerCase()));

  for (const rec of catalog) {
    if (!loaded.has(rec.slug)) continue;
    if (out.has(rec.slug)) continue;
    if (notOffered(rec, ctx.audience)) continue;
    if (rec.activates_when.some((r) => r.kind === "baseline")) {
      out.add(rec.slug);
      continue;
    }
    if (rec.maturity === "experimental") continue;
    if (ctx.mode === "user_turn" && suppressedOnSurface(rec, ctx.surface)) continue;
    if (ctx.mode === "user_turn") {
      const text = (ctx.user_text ?? "").toLowerCase();
      if (matchesUserTurn(rec.activates_when, text, drivers, templates, false)) {
        out.add(rec.slug);
      }
    } else {
      const localDrivers = new Set(drivers);
      for (const d of inferDriversFromToolInput(ctx.tool, ctx.input))
        localDrivers.add(d.toLowerCase());
      const stepKinds = new Set(inferStepKindsFromToolInput(ctx.tool, ctx.input));
      if (matchesToolCall(rec.activates_when, ctx, localDrivers, templates, stepKinds)) {
        out.add(rec.slug);
      }
    }
  }
  return [...out];
}

export function autoloadForDiagnoses(
  codes: readonly string[],
  catalog: readonly ActivationRecord[],
  currently_loaded: readonly string[],
  surface?: string,
  audience?: SkillAudience,
): string[] {
  if (codes.length === 0) return [];
  const have = new Set(currently_loaded);
  const seen = new Set(codes);
  const out = new Set<string>();
  for (const rec of catalog) {
    if (have.has(rec.slug)) continue;
    if (rec.maturity === "experimental") continue;
    if (suppressedOnSurface(rec, surface)) continue;
    if (notOffered(rec, audience)) continue;
    if (
      rec.activates_when.some(
        (rule) => rule.kind === "diagnosis" && rule.codes.some((code) => seen.has(code)),
      )
    )
      out.add(rec.slug);
  }
  return rankAndOrder(out, catalog);
}

export function diagnosisCodesFromToolResult(result: unknown): string[] {
  const codes = new Set<string>();
  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const entry = pickObject(item);
      if (typeof entry.code === "string" && entry.code) codes.add(entry.code);
      if (typeof entry.reason === "string" && entry.reason) codes.add(entry.reason);
    }
  };
  const visit = (value: unknown): void => {
    const node = pickObject(value);
    collect(node.repair_guidance);
    collect(node.diagnoses);
  };
  const root = pickObject(result);
  visit(root);
  for (const value of Object.values(root)) visit(value);
  return [...codes];
}

export function listBaselineSlugs(catalog: readonly ActivationRecord[]): string[] {
  const out: string[] = [];
  for (const rec of catalog) {
    if (rec.activates_when.some((r) => r.kind === "baseline")) out.push(rec.slug);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

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
      case "baseline":
      case "intent_keyword":
      case "diagnosis":
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
      case "tool":
      case "tool_arg":
      case "step_kind":
      case "diagnosis":
        break;
    }
  }
  return false;
}

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

function driversFromStep(raw: unknown): string[] {
  const step = pickObject(raw);
  const cfg = pickObject(step.config);
  const drivers: string[] = [];
  if (typeof cfg.driver === "string") drivers.push(cfg.driver);
  if (typeof step.driver === "string") drivers.push(step.driver as string);
  if (step.graphql !== undefined) drivers.push("graphql");
  return drivers;
}

function inferDriversFromToolInput(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  if (tool === "edit_workflow_patch") {
    const patches = (input as Record<string, unknown>).patches;
    if (!Array.isArray(patches)) return [];
    const drivers: string[] = [];
    for (const patch of patches) {
      const value = pickObject(patch).value;
      if (Array.isArray(value)) {
        for (const raw of value) drivers.push(...driversFromStep(raw));
      } else {
        drivers.push(...driversFromStep(value));
      }
    }
    return drivers;
  }
  return [];
}

function pickObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function inferStepKindsFromToolInput(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  const visit = (raw: unknown): void => {
    const step = pickObject(raw);
    if (typeof step.kind === "string") out.push(step.kind);
    if (step.for_each !== undefined && step.for_each !== null) out.push("loop");
    if (Array.isArray(step.then_steps)) for (const s of step.then_steps) visit(s);
    if (Array.isArray(step.else_steps)) for (const s of step.else_steps) visit(s);
    if (Array.isArray(step.branches))
      for (const branch of step.branches) {
        if (Array.isArray(branch)) for (const s of branch) visit(s);
      }
    if (Array.isArray(step.body_steps)) for (const s of step.body_steps) visit(s);
  };
  if (tool === "edit_workflow_patch") {
    const record = input as Record<string, unknown>;
    const entries = [
      ...(Array.isArray(record.patches) ? record.patches : []),
      ...(Array.isArray(record.step_patches) ? record.step_patches : []),
    ];
    for (const entry of entries) {
      const patch = pickObject(entry);
      if (typeof patch.path === "string" && FOR_EACH_PATH.test(patch.path)) out.push("loop");
      const value = patch.value;
      if (Array.isArray(value)) for (const raw of value) visit(raw);
      else visit(value);
    }
    return out;
  }
  return out;
}

const FOR_EACH_PATH = /(^|\/)for_each(\/|$)/;

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
