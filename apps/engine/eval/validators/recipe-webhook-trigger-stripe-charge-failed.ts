import { getBuiltinTemplate } from "../../src/connectors/templates.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  template_slug: string;
  recipe_slug: string;
  expected_trigger_kind: string;
  expected_trigger_source: string;
  expected_event: string;
  expected_verify: string;
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
      reason: `recipe ${input.recipe_slug} has no workflow.trigger; webhook primitive coverage regressed`,
    };
  }
  const fails: string[] = [];
  if (trigger.kind !== input.expected_trigger_kind) {
    fails.push(`trigger.kind expected ${input.expected_trigger_kind}, got ${String(trigger.kind)}`);
  }
  if (trigger.source !== input.expected_trigger_source) {
    fails.push(
      `trigger.source expected ${input.expected_trigger_source}, got ${String(trigger.source)}`,
    );
  }
  const events = Array.isArray(trigger.events) ? (trigger.events as unknown[]) : [];
  if (!events.includes(input.expected_event)) {
    fails.push(`trigger.events missing ${input.expected_event}; got ${JSON.stringify(events)}`);
  }
  if (trigger.verify !== input.expected_verify) {
    fails.push(`trigger.verify expected ${input.expected_verify}, got ${String(trigger.verify)}`);
  }
  if (fails.length > 0) return { pass: false, reason: fails.join("; ") };
  return {
    pass: true,
    metrics: {
      events_declared: events.length,
    },
  };
}
