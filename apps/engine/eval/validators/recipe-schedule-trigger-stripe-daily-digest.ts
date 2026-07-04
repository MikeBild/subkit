// Schedule-trigger primitive coverage. Pins the shipped
// `stripe.daily-charges-digest` recipe to the cron + tz + business-days
// contract the scheduler reconciler enforces. Loud failure here catches
// the case where a future edit drops the schedule trigger (which would
// silently revert the recipe to needing an external `sk run` loop) or
// downgrades the timezone / business-day discipline.

import { getBuiltinTemplate } from "../../src/connectors/templates.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  template_slug: string;
  recipe_slug: string;
  expected_trigger_kind: string;
  expected_cron: string;
  expected_tz: string;
  expected_business_days_only: boolean;
  min_skip_dates: number;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const template = getBuiltinTemplate(input.template_slug);
  if (!template) {
    return { pass: false, reason: `template ${input.template_slug} not loadable` };
  }
  const recipe = template.recipes.find((r) => r.slug === input.recipe_slug);
  if (!recipe) {
    return {
      pass: false,
      reason: `recipe ${input.template_slug}.${input.recipe_slug} not found`,
    };
  }
  const trigger = (recipe.workflow as { trigger?: Record<string, unknown> }).trigger;
  if (!trigger) {
    return {
      pass: false,
      reason: `recipe ${input.recipe_slug} has no workflow.trigger; schedule primitive coverage regressed`,
    };
  }
  const fails: string[] = [];
  if (trigger.kind !== input.expected_trigger_kind) {
    fails.push(`trigger.kind expected ${input.expected_trigger_kind}, got ${String(trigger.kind)}`);
  }
  if (trigger.cron !== input.expected_cron) {
    fails.push(`trigger.cron expected ${input.expected_cron}, got ${String(trigger.cron)}`);
  }
  if (trigger.tz !== input.expected_tz) {
    fails.push(`trigger.tz expected ${input.expected_tz}, got ${String(trigger.tz)}`);
  }
  if (trigger.business_days_only !== input.expected_business_days_only) {
    fails.push(
      `trigger.business_days_only expected ${input.expected_business_days_only}, got ${String(trigger.business_days_only)}`,
    );
  }
  const skipDates = Array.isArray(trigger.skip_dates) ? (trigger.skip_dates as unknown[]) : [];
  if (skipDates.length < input.min_skip_dates) {
    fails.push(
      `trigger.skip_dates expected at least ${input.min_skip_dates}, got ${skipDates.length}`,
    );
  }
  if (fails.length > 0) return { pass: false, reason: fails.join("; ") };
  return {
    pass: true,
    metrics: {
      skip_dates: skipDates.length,
    },
  };
}
