import { generateMainAgentSystemPrompt } from "../../../conversations/agent/context.ts";
import type { AuthoringPromptHint, LlmFlow } from "../../types.ts";

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";

const BASE_SYSTEM_PROMPTS: Record<
  Exclude<LlmFlow, "converse" | "suggest_next" | "workflow_step" | "tool_repair">,
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
  catalog_describe: [
    "You are the subkit workflow engine's catalog flow.",
    "You are given one object of a business's automation catalog, fenced as data in the user's message.",
    "Answer the instructions in the user's message about that object.",
    "Return one JSON object with exactly the fields the user's message asks for and nothing else.",
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
    "Return exactly one JSON object: { reason, missing, verdict }, reason first.",
  ].join(" "),
  critic_authoring: [
    "You are the subkit workflow engine's authoring critic.",
    "A draft has already passed static checks (JSONata syntax, scope references, JSON-schema validity).",
    "You receive the user's goal verbatim and the draft's declared output_schema; flag a draft whose steps or final output cannot deliver what the goal asks for or what output_schema declares.",
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
    "When the input lists a convention rubric, report every listed rule_id in rubric with status pass, fail or n_a and a short note; a failed convention is a warning and never decides passed on its own.",
  ].join(" "),
};

interface BasePrompt {
  content: string;
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
    throw new Error("basePromptFor: suggest_next must use suggestion-prompt.ts");
  }
  if (flow === "tool_repair") {
    throw new Error("basePromptFor: tool_repair composes its own messages");
  }
  return { content: BASE_SYSTEM_PROMPTS[flow] };
}
