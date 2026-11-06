import { createHash } from "node:crypto";
import { applyRecency, type LoadedSkillEntry } from "../../src/conversations/loop/skill-recency.ts";
import {
  type ActivationRecord,
  autoloadForDiagnoses,
  autoloadForToolCall,
  autoloadForUserTurn,
  listBaselineSlugs,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "../../src/conversations/skill-autoload.ts";
import { TOOL_OUTPUT_VERBATIM_TURNS } from "../../src/conversations/tool-output-elision.ts";
import type { Db } from "../../src/db/client.ts";
import { tenants } from "../../src/db/schema/index.ts";
import { countTokens } from "../../src/llm/accounting/index.ts";
import { assembleEnhancedPrompt } from "../../src/llm/runtime/context-assembler.ts";
import {
  applySkillSeeds,
  loadEmbeddedSkillSeeds,
  type SeededSkill,
} from "../../src/skills/seed.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv } from "./shared/authoring-env.ts";

type StepEvent =
  | { tool: string; input: unknown; connector_drivers?: string[] }
  | { diagnoses: string[] };

interface ChatStep {
  id: string;
  user_turn: string;
  needs: string[];
  events: StepEvent[];
}

export interface SkillLoad {
  slug: string;
  turn: number;
}

interface Input {
  family_prefix: string;
  core_slug: string;
  core_marker: string;
  surface: string;
  required_tools: string[];
  steps: ChatStep[];
}

interface StepMeasure {
  tokens: number;
  system_tokens: number;
  skill_result_tokens: number;
  loaded: string[];
  visible: string[];
  trimmed: number;
}

export function visibleLoads(
  loads: readonly SkillLoad[],
  turn: number,
  window: number = TOOL_OUTPUT_VERBATIM_TURNS,
): SkillLoad[] {
  return loads.filter((load) => load.turn <= turn && load.turn > turn - window);
}

export function planSkillLoads(
  needsPerTurn: readonly (readonly string[])[],
  window: number = TOOL_OUTPUT_VERBATIM_TURNS,
): SkillLoad[] {
  const loads: SkillLoad[] = [];
  for (const [index, needs] of needsPerTurn.entries()) {
    const turn = index + 1;
    const visible = new Set(visibleLoads(loads, turn - 1, window - 1).map((load) => load.slug));
    for (const slug of new Set(needs)) {
      if (!visible.has(slug)) loads.push({ slug, turn });
    }
  }
  return loads;
}

export function singleSkillNeeds(
  needs: readonly string[],
  familyPrefix: string,
  coreSlug: string,
): string[] {
  return [...new Set(needs.map((slug) => (slug.startsWith(familyPrefix) ? coreSlug : slug)))];
}

const AUDIENCE = "chat" as const;

export function singleSkillCatalog(
  seeds: readonly SeededSkill[],
  familyPrefix: string,
  coreSlug: string,
): SeededSkill[] {
  const family = seeds.filter((skill) => skill.slug.startsWith(familyPrefix));
  const core = family.find((skill) => skill.slug === coreSlug);
  if (!core) throw new Error(`core skill ${coreSlug} missing from seeds`);
  const topics = family.filter((skill) => skill.slug !== coreSlug);
  const body = [core.body, ...topics.map((skill) => skill.body)].join("\n\n");
  const merged: SeededSkill = {
    ...core,
    body,
    body_hash: createHash("sha256").update(body).digest("hex"),
  };
  return [...seeds.filter((skill) => !skill.slug.startsWith(familyPrefix)), merged];
}

async function insertTenant(db: Db, slug: string): Promise<string> {
  const [row] = await db
    .insert(tenants)
    .values({ slug, display_name: slug })
    .returning({ id: tenants.id });
  if (!row) throw new Error(`tenant ${slug} insert failed`);
  return row.id;
}

function applyToolEvents(
  events: readonly StepEvent[],
  catalog: readonly ActivationRecord[],
  loaded: LoadedSkillEntry[],
  turn: number,
  surface: string,
): LoadedSkillEntry[] {
  let entries = loaded;
  for (const event of events) {
    const membership = entries.map((entry) => entry.slug);
    if ("diagnoses" in event) {
      const added = autoloadForDiagnoses(event.diagnoses, catalog, membership, surface, AUDIENCE);
      entries = [...entries, ...added.map((slug) => ({ slug, last_turn: turn }))];
      continue;
    }
    const ctx = {
      tool: event.tool,
      input: event.input,
      audience: AUDIENCE,
      ...(event.connector_drivers ? { connector_drivers: event.connector_drivers } : {}),
    };
    const added = autoloadForToolCall(ctx, catalog, membership);
    const reaffirmed = new Set(
      reaffirmLoadedForTurn({ mode: "tool_call", ...ctx }, catalog, membership),
    );
    entries = [
      ...entries.map((entry) =>
        reaffirmed.has(entry.slug) ? { slug: entry.slug, last_turn: turn } : entry,
      ),
      ...added.map((slug) => ({ slug, last_turn: turn })),
    ];
  }
  return entries;
}

function loadResultTokens(skill: SeededSkill | undefined): number {
  if (!skill) return 0;
  return countTokens(
    JSON.stringify({
      ok: true,
      data: {
        slug: skill.slug,
        skill: { title: skill.title, body: skill.body, scope: skill.scope },
      },
    }),
  );
}

async function replay(
  db: Db,
  tenant_id: string,
  input: Input,
  skills: readonly SeededSkill[],
  needsPerTurn: readonly (readonly string[])[],
): Promise<Map<string, StepMeasure>> {
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
  const loads = planSkillLoads(needsPerTurn);
  const catalog = await loadActivationCatalog(tenant_id, db);
  const baseline = new Set(listBaselineSlugs(catalog));
  const out = new Map<string, StepMeasure>();
  let loaded: LoadedSkillEntry[] = [];
  for (const [index, step] of input.steps.entries()) {
    const turn = index + 1;
    const slugs = loaded.map((entry) => entry.slug);
    const reaffirmed = reaffirmLoadedForTurn(
      { mode: "user_turn", user_text: step.user_turn, surface: input.surface, audience: AUDIENCE },
      catalog,
      slugs,
    );
    const refresh = new Set([...slugs.filter((slug) => baseline.has(slug)), ...reaffirmed]);
    const additions = autoloadForUserTurn(
      {
        user_text: step.user_turn,
        first_turn: turn === 1,
        surface: input.surface,
        audience: AUDIENCE,
      },
      catalog,
      slugs,
    );
    const recency = applyRecency(loaded, turn, refresh, additions, baseline);
    loaded = recency.next;
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: step.user_turn }],
        max_tokens: 1_000_000,
        loaded_skill_slugs: recency.fullBodySet,
        loaded_skill_membership: recency.membership,
        surface: input.surface as "cockpit",
      },
      db,
    );
    const visible = visibleLoads(loads, turn);
    const skillResultTokens = visible.reduce(
      (sum, load) => sum + loadResultTokens(bySlug.get(load.slug)),
      0,
    );
    out.set(step.id, {
      tokens: prompt.token_counts.total + skillResultTokens,
      system_tokens: prompt.token_counts.total,
      skill_result_tokens: skillResultTokens,
      loaded: recency.fullBodySet,
      visible: [...new Set(visible.map((load) => load.slug))],
      trimmed: prompt.dropped_sections.length,
    });
    loaded = applyToolEvents(step.events, catalog, loaded, turn, input.surface);
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const seeds = loadEmbeddedSkillSeeds();
  c.check(
    seeds.errors.length === 0,
    `skill seeds failed to parse: ${JSON.stringify(seeds.errors)}`,
  );
  const core = seeds.skills.find((skill) => skill.slug === input.core_slug);
  c.check(
    core?.body.includes(input.core_marker) === true,
    `core marker ${JSON.stringify(input.core_marker)} is not in ${input.core_slug}`,
  );
  const tools = new Set(
    input.steps.flatMap((step) =>
      step.events.flatMap((event) => ("tool" in event ? [event.tool] : [])),
    ),
  );
  for (const tool of input.required_tools) {
    c.check(tools.has(tool), `the replayed conversation never reaches ${tool}`);
  }

  const knownSlugs = new Set(seeds.skills.map((skill) => skill.slug));
  for (const step of input.steps) {
    c.check(step.needs.length > 0, `step ${step.id} names no skill it needs`);
    for (const slug of step.needs) {
      c.check(knownSlugs.has(slug), `step ${step.id} needs unknown skill ${slug}`);
    }
  }
  const singleSkills = singleSkillCatalog(seeds.skills, input.family_prefix, input.core_slug);
  const splitNeeds = input.steps.map((step) => step.needs);
  const singleNeeds = splitNeeds.map((needs) =>
    singleSkillNeeds(needs, input.family_prefix, input.core_slug),
  );

  const { split, single } = await withAuthoringEvalEnv("prompt_size_per_step", async (env) => {
    const singleTenant = await insertTenant(env.db, "t-eval-prompt-size-single-skill");
    await applySkillSeeds(seeds.skills, env.tenant_id, env.db);
    await applySkillSeeds(singleSkills, singleTenant, env.db);
    return {
      split: await replay(env.db, env.tenant_id, input, seeds.skills, splitNeeds),
      single: await replay(env.db, singleTenant, input, singleSkills, singleNeeds),
    };
  });

  const metrics: Record<string, number> = {};
  const splitTokens: number[] = [];
  const singleTokens: number[] = [];
  let smallerSteps = 0;
  for (const step of input.steps) {
    const after = split.get(step.id);
    const before = single.get(step.id);
    if (!after || !before) {
      c.check(false, `step ${step.id} was not measured`);
      continue;
    }
    metrics[`prompt_tokens_step_${step.id}`] = after.tokens;
    metrics[`single_skill_prompt_tokens_step_${step.id}`] = before.tokens;
    metrics[`skill_result_tokens_step_${step.id}`] = after.skill_result_tokens;
    metrics[`single_skill_result_tokens_step_${step.id}`] = before.skill_result_tokens;
    splitTokens.push(after.tokens);
    singleTokens.push(before.tokens);
    c.check(
      after.loaded.includes(input.core_slug),
      `step ${step.id} lost the core recipe: ${JSON.stringify(after.loaded)}`,
    );
    for (const slug of step.needs) {
      c.check(
        after.visible.includes(slug),
        `step ${step.id} does not carry the body of ${slug}: ${JSON.stringify(after.visible)}`,
      );
    }
    c.check(
      before.visible.includes(input.core_slug),
      `step ${step.id} does not carry the single authoring skill body, so it measures nothing`,
    );
    c.check(
      after.tokens < before.tokens,
      `step ${step.id} is not smaller than the single skill: ${after.tokens} >= ${before.tokens}`,
    );
    if (after.tokens < before.tokens) smallerSteps += 1;
    c.check(after.trimmed === 0, `step ${step.id} trimmed ${after.trimmed} prompt sections`);
  }
  metrics.prompt_tokens_step_mean = mean(splitTokens);
  metrics.single_skill_prompt_tokens_step_mean = mean(singleTokens);
  metrics.prompt_tokens_step_max = Math.max(0, ...splitTokens);
  metrics.single_skill_prompt_tokens_step_max = Math.max(0, ...singleTokens);
  metrics.smaller_than_single_skill_steps = smallerSteps;
  if (c.failed) return { pass: false, reason: c.failed, metrics };
  return { pass: true, metrics };
}
