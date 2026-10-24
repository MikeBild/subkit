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
import type { Db } from "../../src/db/client.ts";
import { tenants } from "../../src/db/schema/index.ts";
import { assembleEnhancedPrompt } from "../../src/llm/core/context-assembler.ts";
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
  events: StepEvent[];
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
  loaded: string[];
  trimmed: number;
  core_in_system: boolean;
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

async function replay(db: Db, tenant_id: string, input: Input): Promise<Map<string, StepMeasure>> {
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
    out.set(step.id, {
      tokens: prompt.token_counts.total,
      loaded: recency.fullBodySet,
      trimmed: prompt.dropped_sections.length,
      core_in_system: prompt.system.includes(input.core_marker),
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

  const { split, single } = await withAuthoringEvalEnv("prompt_size_per_step", async (env) => {
    const singleTenant = await insertTenant(env.db, "t-eval-prompt-size-single-skill");
    await applySkillSeeds(seeds.skills, env.tenant_id, env.db);
    await applySkillSeeds(
      singleSkillCatalog(seeds.skills, input.family_prefix, input.core_slug),
      singleTenant,
      env.db,
    );
    return {
      split: await replay(env.db, env.tenant_id, input),
      single: await replay(env.db, singleTenant, input),
    };
  });

  const metrics: Record<string, number> = {};
  const splitTokens: number[] = [];
  const singleTokens: number[] = [];
  let coreInSystemSteps = 0;
  for (const step of input.steps) {
    const after = split.get(step.id);
    const before = single.get(step.id);
    if (!after || !before) {
      c.check(false, `step ${step.id} was not measured`);
      continue;
    }
    metrics[`prompt_tokens_step_${step.id}`] = after.tokens;
    metrics[`single_skill_prompt_tokens_step_${step.id}`] = before.tokens;
    splitTokens.push(after.tokens);
    singleTokens.push(before.tokens);
    if (after.core_in_system) coreInSystemSteps += 1;
    c.check(
      after.loaded.includes(input.core_slug),
      `step ${step.id} lost the core recipe: ${JSON.stringify(after.loaded)}`,
    );
    c.check(
      before.loaded.includes(input.core_slug),
      `step ${step.id} does not load the single authoring skill, so it measures nothing`,
    );
    c.check(after.trimmed === 0, `step ${step.id} trimmed ${after.trimmed} prompt sections`);
  }
  metrics.prompt_tokens_step_mean = mean(splitTokens);
  metrics.single_skill_prompt_tokens_step_mean = mean(singleTokens);
  metrics.prompt_tokens_step_max = Math.max(0, ...splitTokens);
  metrics.single_skill_prompt_tokens_step_max = Math.max(0, ...singleTokens);
  metrics.core_body_in_system_steps = coreInSystemSteps;
  if (c.failed) return { pass: false, reason: c.failed, metrics };
  return { pass: true, metrics };
}
