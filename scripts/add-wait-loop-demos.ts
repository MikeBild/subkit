// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are consumed by the executor's substitution parser at run time.
//
// Workstream D (continued) — demonstration recipes for WaitStep
// (short, in-process, ≤6h) and LoopStep.data_selector (JS-arrow form).
// CallStep + ToolStep + LoopStep `over` form land separately once
// their executor wiring catches up to the schema (CallStep already
// runs but needs sub-workflow registration scaffolding to make a
// realistic recipe).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");
const SLACK_BASE = "${connector.slack.base_url}";
const GITHUB_BASE = "${connector.github.base_url}";

type Recipe = Record<string, unknown>;
type Template = { slug: string; recipes?: Recipe[] };

interface RecipeDef {
  template_slug: string;
  recipe: Recipe;
}

const DEMOS: RecipeDef[] = [
  {
    template_slug: "slack",
    recipe: {
      slug: "post-then-pause-then-edit",
      title: "Post a Slack message, pause briefly, then edit it",
      description:
        "Demonstrates WaitStep (short, in-process, duration_ms ≤ 6h). Posts an initial message, pauses three seconds to let downstream consumers see the original, then edits with the final shape. Useful for staged announcements + 'we're processing your request' patterns.",
      intent_keywords: [
        "post then edit slack",
        "wait between slack messages",
        "staged slack announcement",
      ],
      derived_from_skill: null,
      category: "communication",
      tags: ["wait", "demonstration"],
      difficulty: "intermediate",
      estimated_setup_minutes: 4,
      prerequisites: ["Slack bot token with `chat:write`"],
      sample_input: { channel: "#ops", initial_text: "Working on it…", final_text: "All clear." },
      expected_output_preview: { ok: true, ts: "1714000000.000100" },
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "slack-post-pause-edit",
        description: "Post → wait 3s → chat.update on the same ts.",
        input_schema: {
          type: "object",
          required: ["channel", "initial_text", "final_text"],
          properties: {
            channel: { type: "string" },
            initial_text: { type: "string" },
            final_text: { type: "string" },
          },
        },
        steps: [
          {
            kind: "request",
            id: "post",
            method: "POST",
            url: `${SLACK_BASE}/chat.postMessage`,
            headers: { "content-type": "application/json" },
            body: {
              channel: "${input.channel}",
              text: "${input.initial_text}",
            },
          },
          {
            kind: "wait",
            id: "pause",
            duration_ms: 3000,
          },
          {
            kind: "request",
            id: "edit",
            method: "POST",
            url: `${SLACK_BASE}/chat.update`,
            headers: { "content-type": "application/json" },
            body: {
              channel: "${input.channel}",
              ts: "${post.body.ts}",
              text: "${input.final_text}",
            },
          },
        ],
      },
    },
  },
  {
    template_slug: "github",
    recipe: {
      slug: "list-all-repos-paginate-js-form",
      title: "Page through every authenticated user's repo with the JS data_selector form",
      description:
        "Demonstrates LoopStep.data_selector — JS arrow form. The selector body receives `sourceData` bound to the full execution scope and returns the array to iterate. Equivalent to the path-string form but lets you reach into a derived array (e.g. filter or flatten).",
      intent_keywords: ["loop js arrow", "data_selector js", "iterate paginated repos"],
      derived_from_skill: null,
      category: "devops",
      tags: ["loop", "demonstration"],
      difficulty: "advanced",
      estimated_setup_minutes: 5,
      prerequisites: ["GitHub PAT with `repo` scope"],
      sample_input: null,
      expected_output_preview: null,
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: {
        name: "github-loop-via-js-data-selector",
        description: "List + iterate repos using the JS arrow form of data_selector.",
        steps: [
          {
            kind: "request",
            id: "list",
            method: "GET",
            url: `${GITHUB_BASE}/user/repos`,
            query: { per_page: 100, sort: "updated" },
            pagination: {
              strategy: "page",
              page_size: 100,
              page_param: "page",
              limit_param: "per_page",
            },
          },
          {
            kind: "loop",
            id: "iterate",
            data_selector:
              "(sourceData) => sourceData.list.body.filter(function(r){ return !r.fork; })",
            body: ["per_repo_log"],
            item_var: "repo",
          },
          {
            kind: "transform",
            id: "per_repo_log",
            expression: '{ "name": $.repo.full_name, "updated_at": $.repo.updated_at }',
          },
        ],
      },
    },
  },
];

function main() {
  const raw = readFileSync(TEMPLATES_PATH, "utf8");
  const templates = JSON.parse(raw) as Template[];
  let added = 0;
  let skipped = 0;
  for (const def of DEMOS) {
    const tpl = templates.find((t) => t.slug === def.template_slug);
    if (!tpl) {
      console.warn(`skip: template \`${def.template_slug}\` not found`);
      skipped += 1;
      continue;
    }
    const existing = tpl.recipes ?? [];
    if (existing.some((r) => r.slug === def.recipe.slug)) {
      console.log(`skip: ${def.template_slug}/${def.recipe.slug} already exists`);
      skipped += 1;
      continue;
    }
    tpl.recipes = [...existing, def.recipe];
    added += 1;
    console.log(`added: ${def.template_slug}/${def.recipe.slug}`);
  }
  writeFileSync(TEMPLATES_PATH, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
  console.log(
    `done: added ${added}, skipped ${skipped}; total recipes: ${templates.reduce((s, t) => s + (t.recipes?.length ?? 0), 0)}`,
  );
}

main();
