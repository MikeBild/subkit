import {
  type ActivationRecord,
  autoloadForDiagnoses,
  autoloadForToolCall,
  autoloadForUserTurn,
  listBaselineSlugs,
} from "../../src/conversations/skill-autoload.ts";
import { loadEmbeddedSkillSeeds } from "../../src/skills/seed.ts";
import type { SkillActivation } from "../../src/skills/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks } from "./shared/authoring-env.ts";

type PhaseEvent =
  | { user_turn: string; first_turn?: boolean; connector_drivers?: string[] }
  | { tool: string; input: unknown; connector_drivers?: string[] }
  | { diagnoses: string[] };

interface Phase {
  id: string;
  events: PhaseEvent[];
}

interface Rule {
  id: string;
  category: "convention" | "consistency" | "contradiction";
  phases: string[];
  fragments: string[];
}

interface Input {
  phases: Phase[];
  rules: Rule[];
  controls: { unreachable_activation: SkillActivation[] };
}

interface GuidanceSkill extends ActivationRecord {
  body: string;
}

const CONTROL_SLUG = "guidance-control";

function loadedSlugs(phase: Phase, catalog: readonly GuidanceSkill[]): Set<string> {
  const loaded = new Set<string>(listBaselineSlugs(catalog));
  for (const event of phase.events) {
    const have = [...loaded];
    const added =
      "user_turn" in event
        ? autoloadForUserTurn(
            {
              user_text: event.user_turn,
              first_turn: event.first_turn === true,
              surface: "cockpit",
              ...(event.connector_drivers ? { connector_drivers: event.connector_drivers } : {}),
            },
            catalog,
            have,
          )
        : "tool" in event
          ? autoloadForToolCall(
              {
                tool: event.tool,
                input: event.input,
                ...(event.connector_drivers ? { connector_drivers: event.connector_drivers } : {}),
              },
              catalog,
              have,
            )
          : autoloadForDiagnoses(event.diagnoses, catalog, have, "cockpit");
    for (const slug of added) loaded.add(slug);
  }
  return loaded;
}

function guidanceFor(phase: Phase, catalog: readonly GuidanceSkill[]): string {
  const loaded = loadedSlugs(phase, catalog);
  return catalog
    .filter((skill) => loaded.has(skill.slug))
    .map((skill) => skill.body)
    .join("\n\n");
}

function missingRules(
  rules: readonly Rule[],
  phases: readonly Phase[],
  catalog: readonly GuidanceSkill[],
): string[] {
  const missing: string[] = [];
  for (const phase of phases) {
    const text = guidanceFor(phase, catalog);
    for (const rule of rules) {
      if (!rule.phases.includes(phase.id)) continue;
      const absent = rule.fragments.filter((fragment) => !text.includes(fragment));
      if (absent.length > 0) missing.push(`${rule.id}@${phase.id}: ${JSON.stringify(absent)}`);
    }
  }
  return missing;
}

function moveRule(
  rule: Rule,
  catalog: readonly GuidanceSkill[],
  activates_when: SkillActivation[],
): GuidanceSkill[] {
  const moved: string[] = [];
  const rest = catalog.map((skill) => {
    const paragraphs = skill.body.split(/\n{2,}/);
    const keep = paragraphs.filter((paragraph) => {
      const carries = rule.fragments.some((fragment) => paragraph.includes(fragment));
      if (carries) moved.push(paragraph);
      return !carries;
    });
    return { ...skill, body: keep.join("\n\n") };
  });
  return [
    ...rest,
    {
      slug: CONTROL_SLUG,
      activates_when,
      maturity: "stable",
      side_effects: "read",
      tags: [],
      body: moved.join("\n\n"),
    },
  ];
}

function toolsOf(phases: readonly Phase[]): string[] {
  return phases.flatMap((phase) =>
    phase.events.flatMap((event) => ("tool" in event ? [event.tool] : [])),
  );
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const seeds = loadEmbeddedSkillSeeds();
  c.check(
    seeds.errors.length === 0,
    `skill seeds failed to parse: ${JSON.stringify(seeds.errors)}`,
  );
  const catalog: GuidanceSkill[] = seeds.skills
    .filter((skill) => skill.maturity !== "experimental")
    .map((skill) => ({
      slug: skill.slug,
      activates_when: skill.activates_when,
      maturity: skill.maturity,
      side_effects: skill.side_effects,
      tags: skill.tags,
      body: skill.body,
    }));

  const phaseIds = new Set(input.phases.map((phase) => phase.id));
  for (const rule of input.rules) {
    for (const id of rule.phases)
      c.check(phaseIds.has(id), `rule ${rule.id} names unknown phase ${id}`);
  }

  const missing = missingRules(input.rules, input.phases, catalog);
  c.check(missing.length === 0, `guidance not reachable: ${missing.join("; ")}`);

  let unreachableDetected = 0;
  let reachableKept = 0;
  for (const rule of input.rules) {
    const rulePhases = input.phases.filter((phase) => rule.phases.includes(phase.id));
    const hidden = missingRules(
      [rule],
      rulePhases,
      moveRule(rule, catalog, input.controls.unreachable_activation),
    );
    if (hidden.length > 0) unreachableDetected += 1;
    else c.check(false, `control: ${rule.id} still passes after moving it out of reach`);
    const reachable: SkillActivation[] = [...new Set(toolsOf(rulePhases))].map((tool) => ({
      kind: "tool",
      tool,
    }));
    const kept = missingRules([rule], rulePhases, moveRule(rule, catalog, reachable));
    if (kept.length === 0) reachableKept += 1;
    else c.check(false, `control: ${rule.id} fails after a reachable move: ${kept.join("; ")}`);
  }

  const metrics: Record<string, number> = {
    rules: input.rules.length,
    unreachable_detected: unreachableDetected,
    reachable_kept: reachableKept,
  };
  for (const phase of input.phases) {
    metrics[`guidance_chars_${phase.id}`] = guidanceFor(phase, catalog).length;
  }
  if (c.failed) return { pass: false, reason: c.failed, metrics };
  return { pass: true, metrics };
}
