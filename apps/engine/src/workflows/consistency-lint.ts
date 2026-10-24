import type { ts as TsApi } from "ts-morph";
import { type ActiveConventions, conventionKey } from "../skills/conventions.ts";
import type { SkillRule } from "../skills/types.ts";
import { loadTs } from "./js-body-lint.ts";
import { workflowJsonataSites } from "./jsonata-sites.ts";
import { buildStepTopology, type PriorWorkflowRef } from "./prior-workflows.ts";
import type { WorkflowDef } from "./types.ts";
import { TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION } from "./types-web-scraper.ts";
import type { ValidationError } from "./validator.ts";

export const DEFAULT_TENANT_TIMEZONE = "Europe/Berlin";

export const CONSISTENCY_RULE_IDS = {
  scheduleTz: "consistency.schedule_tz",
  localeOutsideFmt: "consistency.locale_outside_fmt",
  duplicateName: "consistency.duplicate_name",
  duplicateSteps: "consistency.duplicate_steps",
} as const;

export interface ConsistencyContext {
  conventions: ActiveConventions;
  siblings: readonly PriorWorkflowRef[];
  workflowId?: string | null;
}

type RuleOf<T extends SkillRule["type"]> = Extract<SkillRule, { type: T }>;

const DATE_PART_METHODS = new Set(
  ["Date", "Day", "Month", "FullYear", "Hours", "Minutes", "Seconds"].flatMap((part) => [
    `get${part}`,
    `getUTC${part}`,
  ]),
);
const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
const JSONATA_FORMATTING = /\$(formatNumber|formatInteger)\s*\(|\$fromMillis\s*\([^()]*,/;

function settledRules(conventions: ActiveConventions): SkillRule[] {
  const conflicted = new Set(conventions.conflicts.map((conflict) => conflict.key));
  return conventions.conventions
    .map((entry) => entry.rule)
    .filter((rule) => {
      const key = conventionKey(rule);
      return key === null || !conflicted.has(key);
    });
}

function firstRule<T extends SkillRule["type"]>(
  rules: readonly SkillRule[],
  type: T,
): RuleOf<T> | undefined {
  return rules.find((rule): rule is RuleOf<T> => rule.type === type);
}

function rawScheduleTz(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const trigger = (input as { trigger?: unknown }).trigger;
  if (!trigger || typeof trigger !== "object") return null;
  const tz = (trigger as { tz?: unknown }).tz;
  return typeof tz === "string" && tz.trim().length > 0 ? tz : null;
}

function scheduleTimezoneWarnings(
  input: unknown,
  wf: WorkflowDef,
  rule: RuleOf<"timezone"> | undefined,
): ValidationError[] {
  if (wf.trigger?.kind !== "schedule") return [];
  const expected = rule?.payload.value ?? DEFAULT_TENANT_TIMEZONE;
  const rule_id = rule?.rule_id ?? CONSISTENCY_RULE_IDS.scheduleTz;
  const tz = rawScheduleTz(input);
  if (tz === null)
    return [
      {
        path: "trigger.tz",
        rule_id,
        message: `the schedule trigger sets no tz, so it fires in UTC; the tenant convention is ${expected}. Set trigger.tz to "${expected}" or name the zone you mean explicitly.`,
      },
    ];
  if (tz === expected) return [];
  if (rule === undefined && tz !== "UTC") return [];
  return [
    {
      path: "trigger.tz",
      rule_id,
      message: `the schedule trigger fires in ${tz}, but the tenant convention is ${expected}. Use "${expected}" unless this workflow deliberately runs in another zone.`,
    },
  ];
}

function namingTargets(
  wf: WorkflowDef,
  appliesTo: string,
): Array<{ path: string; label: string; value: string }> {
  const target = appliesTo.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (target === "workflow_slug" || target === "slug")
    return wf.slug ? [{ path: "slug", label: "workflow slug", value: wf.slug }] : [];
  if (target === "workflow_name" || target === "name")
    return [{ path: "name", label: "workflow name", value: wf.name }];
  if (target === "step_id" || target === "step_ids" || target === "step")
    return wf.steps.map((step) => ({
      path: `steps.${step.id}`,
      label: "step id",
      value: step.id,
    }));
  return [];
}

function compilePattern(pattern: string): RegExp | null {
  for (const flags of ["u", ""]) {
    try {
      return new RegExp(pattern, flags);
    } catch {}
  }
  return null;
}

function namingWarnings(wf: WorkflowDef, rules: readonly SkillRule[]): ValidationError[] {
  const warnings: ValidationError[] = [];
  for (const rule of rules) {
    if (rule.type !== "naming") continue;
    const pattern = compilePattern(rule.payload.pattern);
    if (!pattern) continue;
    for (const target of namingTargets(wf, rule.payload.applies_to)) {
      if (pattern.test(target.value)) continue;
      warnings.push({
        path: target.path,
        rule_id: rule.rule_id,
        message: `${target.label} "${target.value}" does not follow the naming convention: ${rule.statement} Expected pattern ${rule.payload.pattern}, for example "${rule.payload.example}".`,
      });
    }
  }
  return warnings;
}

interface JsSurface {
  path: string;
  code: string;
  lintedForLocale: boolean;
}

function javascriptSurfaces(wf: WorkflowDef): JsSurface[] {
  const surfaces: JsSurface[] = [];
  for (const step of wf.steps) {
    if (
      step.kind === "transform" &&
      typeof step.expression === "string" &&
      step.expression.length > 0 &&
      !TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION.has(step.language ?? "javascript")
    )
      surfaces.push({
        path: `steps.${step.id}.expression`,
        code: step.expression,
        lintedForLocale: true,
      });
  }
  if (wf.output_transform_function)
    surfaces.push({
      path: "output_transform_function",
      code: wf.output_transform_function,
      lintedForLocale: false,
    });
  if (wf.validation_function)
    surfaces.push({
      path: "validation_function",
      code: wf.validation_function,
      lintedForLocale: false,
    });
  return surfaces;
}

interface FmtCall {
  member: string;
  options: Map<string, string>;
}

interface FormattingScan {
  handBuiltDate: string | null;
  localeApi: string | null;
  fmtCalls: FmtCall[];
}

function literalOptions(ts: typeof TsApi, node: TsApi.Expression | undefined): Map<string, string> {
  const options = new Map<string, string>();
  if (!node || !ts.isObjectLiteralExpression(node)) return options;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (name && ts.isStringLiteralLike(property.initializer))
      options.set(name, property.initializer.text);
  }
  return options;
}

function scanFormatting(code: string): FormattingScan | null {
  const ts = loadTs();
  const sourceFile = ts.createSourceFile(
    "consistency.js",
    `function __sk_consistency__(input) {\n${code}\n}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ReadonlyArray<unknown> })
    .parseDiagnostics;
  if (Array.isArray(diagnostics) && diagnostics.length > 0) return null;
  const scan: FormattingScan = { handBuiltDate: null, localeApi: null, fmtCalls: [] };
  const visit = (node: TsApi.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const member = node.expression.name.text;
      const target = node.expression.expression;
      if (DATE_PART_METHODS.has(member)) scan.handBuiltDate ??= member;
      if (LOCALE_METHODS.has(member)) scan.localeApi ??= member;
      if (
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === "sk" &&
        target.name.text === "fmt"
      )
        scan.fmtCalls.push({ member, options: literalOptions(ts, node.arguments[1]) });
    }
    if (ts.isIdentifier(node) && node.text === "Intl") scan.localeApi ??= "Intl";
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return scan;
}

function language(tag: string): string {
  return tag.split(/[-_]/)[0]?.toLowerCase() ?? tag.toLowerCase();
}

function localeWarnings(wf: WorkflowDef, rules: readonly SkillRule[]): ValidationError[] {
  const localeRule = firstRule(rules, "locale");
  const timezoneRule = firstRule(rules, "timezone");
  const fmtHint = "sk.fmt.date(value, { tz, pattern, locale }) or sk.fmt.number(value, { locale })";
  const warnings: ValidationError[] = [];
  for (const surface of javascriptSurfaces(wf)) {
    const scan = scanFormatting(surface.code);
    if (!scan) continue;
    if (scan.handBuiltDate)
      warnings.push({
        path: surface.path,
        rule_id: CONSISTENCY_RULE_IDS.localeOutsideFmt,
        message: `the code assembles a date by hand with .${scan.handBuiltDate}(), which ignores the tenant time zone and locale. Format dates with ${fmtHint}.`,
      });
    if (scan.localeApi && !surface.lintedForLocale)
      warnings.push({
        path: surface.path,
        rule_id: CONSISTENCY_RULE_IDS.localeOutsideFmt,
        message: `${scan.localeApi === "Intl" ? "Intl" : `.${scan.localeApi}()`} is not available in the sandbox, so the locale is ignored. Format with ${fmtHint}.`,
      });
    for (const call of scan.fmtCalls) {
      const locale = call.member === "de" ? "de" : call.options.get("locale");
      if (localeRule && locale && language(locale) !== language(localeRule.payload.tag))
        warnings.push({
          path: surface.path,
          rule_id: localeRule.rule_id,
          message: `sk.fmt.${call.member} formats with locale "${locale}", but the tenant convention is ${localeRule.payload.tag}: ${localeRule.statement}`,
        });
      const tz = call.options.get("tz");
      if (timezoneRule && call.member === "date" && tz && tz !== timezoneRule.payload.value)
        warnings.push({
          path: surface.path,
          rule_id: timezoneRule.rule_id,
          message: `sk.fmt.date formats in ${tz}, but the tenant convention is ${timezoneRule.payload.value}: ${timezoneRule.statement}`,
        });
    }
  }
  for (const site of workflowJsonataSites(wf)) {
    const match = JSONATA_FORMATTING.exec(site.expression);
    if (!match) continue;
    warnings.push({
      path: site.path,
      rule_id: CONSISTENCY_RULE_IDS.localeOutsideFmt,
      message: `the JSONata expression formats with $${match[1] ?? "fromMillis"}() instead of sk.fmt, so the tenant locale and time zone are not applied. Move the formatting into a JavaScript transform with ${fmtHint}.`,
    });
  }
  return warnings;
}

function topologyKey(topology: PriorWorkflowRef["step_topology"]): string | null {
  if (!topology.some((step) => step.connector_id !== undefined || step.action !== undefined))
    return null;
  return JSON.stringify(
    topology.map((step) => [step.kind, step.connector_id ?? null, step.action ?? null]),
  );
}

function duplicateWarnings(wf: WorkflowDef, context: ConsistencyContext): ValidationError[] {
  const name = wf.name.trim().toLowerCase();
  const steps = topologyKey(buildStepTopology(wf));
  const siblings = context.siblings
    .filter(
      (sibling) =>
        sibling.id !== context.workflowId && (wf.slug === undefined || sibling.slug !== wf.slug),
    )
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const warnings: ValidationError[] = [];
  for (const sibling of siblings) {
    if (sibling.name.trim().toLowerCase() === name)
      warnings.push({
        path: "name",
        rule_id: CONSISTENCY_RULE_IDS.duplicateName,
        message: `the active workflow ${sibling.slug} already uses the name "${sibling.name}". Pick a distinct name, or change ${sibling.slug} instead of adding a second workflow.`,
      });
    if (steps !== null && topologyKey(sibling.step_topology) === steps)
      warnings.push({
        path: "steps",
        rule_id: CONSISTENCY_RULE_IDS.duplicateSteps,
        message: `the steps repeat the active workflow ${sibling.slug} (same step kinds, connectors and requests). Reuse or extend ${sibling.slug}, or call it with a call step, instead of duplicating its logic.`,
      });
  }
  return warnings;
}

export function consistencyLintWarnings(
  input: unknown,
  wf: WorkflowDef,
  context: ConsistencyContext,
): ValidationError[] {
  const rules = settledRules(context.conventions);
  return [
    ...namingWarnings(wf, rules),
    ...scheduleTimezoneWarnings(input, wf, firstRule(rules, "timezone")),
    ...localeWarnings(wf, rules),
    ...duplicateWarnings(wf, context),
  ];
}
