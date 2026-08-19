// Base system prompts for the ONE-SHOT flows. The structural prompt body
// for `converse` (persona, behaviour skills, authoring-focus blocks) is
// owned by the agent registry — see
// `apps/engine/src/conversations/agent/context.ts`.
//
// `basePromptFor` and `BASE_SYSTEM_PROMPTS` remain the entry point
// for one-shot flows (`generate`, `extract`, `repair`, `summarize`,
// `discover`) that don't go through the conversation agent. The
// `converse` flow asks the MAIN agent registry for its system prompt
// instead — `assembleEnhancedPrompt` calls
// `generateMainAgentSystemPrompt` and uses the result verbatim.
//
// `suggest_next` is excluded because it has its own minimal prompt
// assembler (`llm/core/suggestion-prompt.ts`) that intentionally does
// NOT load skills / knowledge / docs — adding it here would invite a
// future refactor that re-routes it through `assembleEnhancedPrompt`
// and re-introduces the 1M-token empty-turn bug class.

import { generateMainAgentSystemPrompt } from "../../../conversations/agent/context.ts";
import type { AuthoringPromptHint, LlmFlow } from "../../types.ts";

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";

// `workflow_step` is excluded alongside the two below, and for a plainer
// reason: the engine does not compose that prompt at all. The workflow author
// wrote the request body; the engine only carries it to the provider and books
// the tokens.
const BASE_SYSTEM_PROMPTS: Record<
  Exclude<LlmFlow, "converse" | "suggest_next" | "workflow_step">,
  string
> = {
  generate: [
    "You are the subkit workflow engine's generate flow.",
    "Turn the user's description into a typed WorkflowDef draft.",
    "A WorkflowDef has a `name`, optional `slug` / `description`, and an ordered `steps[]` array.",
    "Each step has `kind` (one of: request, transform, call, wait, branch, parallel, loop) and a unique `id`.",
    "Prefer `request` steps with `connector_id` + `path` when a connector is in scope.",
    "Always ground your draft in the provided Skills and connector docs. Never invent endpoints or parameters.",
    "Emit exactly one JSON object matching the WorkflowDef schema. No surrounding prose.",
  ].join(" "),
  extract: [
    "You are the subkit workflow engine's extract flow.",
    "Read the user's sample and emit a canonical JSON representation of the structured fields it contains.",
    "Respect the optional target hint when provided; otherwise infer the tightest schema that fits the sample.",
    "Return one JSON object with a `schema` field describing field names and types, and a `data` field with the extracted values.",
  ].join(" "),
  repair: [
    "You are the subkit workflow engine's repair flow.",
    "A step has failed and you are given the diff between the captured response and the last known schema.",
    "Propose the smallest possible patch that will make the step compatible with the new response shape.",
    "Classify the patch as `safe` (schema-only), `risky` (semantic), or `blocked` (requires human review).",
    "Return one JSON object with `patch`, `classification`, and `notes`.",
  ].join(" "),
  discover: [
    "You are the subkit workflow engine's discovery flow.",
    "Analyze the given file content to identify three kinds of artifacts:",
    "1. Connectors: API integrations (from OpenAPI specs, code with API calls, config files with connection strings).",
    "2. Skills: operational rules, compliance requirements, best practices (from SOP documents, compliance docs).",
    "3. Knowledge Sources: reference material that should be indexed for retrieval (from runbooks, glossaries).",
    "For each artifact, provide: kind, title, description, structured draft data, evidence excerpts, and a confidence score (0-100).",
    "Be precise. Only propose artifacts you have strong evidence for. Never invent URLs, endpoints, or credentials.",
    "Return a JSON object with an `artifacts` array.",
  ].join(" "),
  summarize: [
    "You are the subkit workflow engine's summarize flow.",
    "Compress the user's input into a short operator-facing summary.",
    "Keep the result factual, compact, and plain text.",
    "Do not add markdown headings, bullet lists, or JSON unless the user explicitly asks for them.",
  ].join(" "),
  judge: [
    "You are the subkit workflow engine's preview judge — a strict, deterministic evaluator.",
    "You are given the user's goal verbatim, a compact summary of the workflow definition, and the recorded step outputs from a green preview.",
    "Decide whether the previewed OUTPUT satisfies the goal. Judge content, not style: minor format differences are fine, but an empty value where the goal requires data is never a pass.",
    "Return exactly one JSON object: { verdict, reason, missing }.",
  ].join(" "),
  critic_authoring: [
    "You are the subkit workflow engine's authoring critic.",
    "A draft has already passed static checks (JSONata syntax, scope references, JSON-schema validity).",
    "Your only job is to flag SEMANTIC drift and STRUCTURAL-QUALITY problems that static checks cannot catch:",
    "steps in an order that produces nonsense (e.g. transform before the request it reads);",
    "`output_transform` that names fields the upstream step does not produce;",
    "idempotency assumptions that won't hold (retrying a POST without an idempotency key, etc.);",
    "AVOIDABLE SEQUENTIAL WORK — a `loop` whose body is independent READ requests (GET / query / SELECT): it runs serially and pays N× wall-clock; flag it and suggest a `for_each` step, which fans out reads concurrently;",
    "SILENT DATA LOSS — a transform with a catch-all that returns ''/null/[] for unmatched input, or an `output_transform`/projection that drops fields the goal needs; flag the dropped data;",
    "INCOMPLETE TRAVERSAL — fetching only the top level of a paginated or TREE resource (e.g. one `/children` call where nested nodes have `has_children`) when the goal implies all items/descendants; flag the missing pagination or depth.",
    "Report problems. Do NOT propose code or patches.",
    "If everything looks reasonable, return passed:true with an empty repairs array.",
    "Cap repairs at 5 short, imperative sentences. Each item must be actionable in a single edit.",
    "rationale is a one-paragraph explanation of the call; keep it under 800 characters.",
  ].join(" "),
};

/**
 * Return the system prompt body for a one-shot flow. The `converse`
 * flow does NOT pass through this — it asks the agent registry for
 * its prompt directly. We keep the function exported with a `converse`
 * branch only so legacy callers (tests, eval fixtures) that ask for
 * the converse base get a small helpful fallback rather than throwing.
 */
/** A base prompt, split into the part that survives a turn and the part that does not. */
export interface BasePrompt {
  /** Stable across turns of one conversation — safe inside the cached prefix. */
  content: string;
  /** Per-turn; must be rendered behind the cache breakpoint. */
  volatile?: string;
}

export async function basePromptFor(
  flow: LlmFlow,
  surface?: ConversationSurface,
  authoringHint?: AuthoringPromptHint,
): Promise<BasePrompt> {
  if (flow === "converse") {
    const result = await generateMainAgentSystemPrompt({
      ...(surface ? { surface } : {}),
      ...(authoringHint ? { authoring_hint: authoringHint } : {}),
    });
    return { content: result.content, ...(result.volatile ? { volatile: result.volatile } : {}) };
  }
  if (flow === "workflow_step") {
    throw new Error(
      "basePromptFor: workflow_step carries an author-written body, not a base prompt",
    );
  }
  if (flow === "suggest_next") {
    // `suggest_next` is intentionally outside this assembler's purview
    // — see the BASE_SYSTEM_PROMPTS comment above. Callers must use
    // `llm/core/suggestion-prompt.ts` directly. Throwing here keeps a
    // future drift towards the heavy assembler from compiling.
    throw new Error("basePromptFor: suggest_next must use suggestion-prompt.ts");
  }
  return { content: BASE_SYSTEM_PROMPTS[flow] };
}
