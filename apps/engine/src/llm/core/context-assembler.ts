// Context assembler — single entry point for LLM-bound prompt construction.
//
// Responsibilities:
//   1) Load applicable skills (global → connector → workflow scope)
//   2) Load connector docs + knowledge-source chunks via semantic search
//   3) Format sections (skills, docs, knowledge, failures, user memory)
//   4) Enforce a per-model token budget via js-tiktoken, gracefully
//      dropping lowest-priority sections until it fits (never the user
//      turn). The trimmed list is surfaced on the return value.
//   5) Split the resulting system prompt into stable + volatile cache
//      blocks so the provider can cache the head and recompute only the
//      tail each turn.
//
// Replaces the prior `llm/context.ts` implementation entirely — all
// callers now import from this module.

import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { searchDocs } from "../../docs-ingestion/service.ts";
import { searchKnowledge } from "../../knowledge/service.ts";
import { logger } from "../../logging/logger.ts";
import {
  getSkill,
  listAutoLoadSkills,
  listSkills,
  retrieveApplicableSkills,
} from "../../skills/service.ts";
import type { Skill } from "../../skills/types.ts";
import { LlmContextTooLarge } from "../errors.ts";
import { renderRuntimeContextBlock } from "../runtime-context.ts";
import { contextCapFor, countMessagesTokens, countTokens } from "../tokens.ts";
import type {
  AssembleContextParams,
  EnhancedPrompt,
  IncludedChunk,
  IncludedKnowledgeChunk,
  LlmFlow,
  PriorFailure,
  UserTurn,
} from "../types.ts";
import { type CacheBlocks, splitPromptIntoBlocks } from "./cache-blocks.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web";

function converseBasePrompt(surface: ConversationSurface): string {
  const verbosity =
    surface === "sk_headless"
      ? "Respond tersely — the user is using the CLI and parsing output. One paragraph per turn max unless listing structured data."
      : surface === "sk_interactive"
        ? "Respond concisely in conversational prose. Use short bullet lists for enumerations. Never dump raw JSON; summarise."
        : surface === "mcp"
          ? "You are responding to an external MCP client (another AI agent or tool). Prefer machine-readable, stable output. No pleasantries."
          : "Respond conversationally with clear structure.";

  return `You are subkit's authoring + operator assistant. You can introspect tenant state, guide end users conversationally, and draft connectors + workflows in staged steps.

IDEAL USER FLOW:
1. Start conversation-first. Acknowledge the goal, explain what you are trying to establish next, and ask only the single highest-signal follow-up question when information is missing.
2. Suggest templates only when helpful. If the user names a common vendor, call \`suggest_connector_templates\` and offer the top match as an accelerator. Never require template selection; \`start_connector_from_description\` is the default path.
3. Build the connector first. Use \`start_connector_from_template\` or \`start_connector_from_description\`, then keep the draft current with \`update_connector_draft\` and \`validate_connector_draft\`. Before any connector save, run \`probe_connector_draft\` whenever it is technically possible and explain the result in plain language. Save only with \`save_connector_draft\` after the draft is valid and the probe succeeded, unless the user explicitly overrides.
4. Build the workflow second. Use \`inspect_workflow_draft\`, \`propose_step\`, \`connect_steps\`, or \`build_workflow\` after the connector is grounded. Preview before commit with \`dry_run_step\` and iterate on transforms with \`dry_run_transform\`. Validate with \`validate_draft\`. Commit only after explicit user confirmation via \`ask_user_confirm(kind: "commit_draft")\`.
5. Keep state visible. Use \`inspect_connector_draft\`, \`inspect_workflow_draft\`, and \`inspect_authoring_context\` whenever you need to summarize progress, explain what is missing, or resume a prior session.
6. For running or approving: confirm first (ask_user_confirm kind: "external_write"), then execute. Always report the audit_log entry id back to the user.
7. Load domain skills on demand. If a task requires specialised knowledge (self-healing classifications, OAuth flows, connector specifics), call \`load_skill(slug)\` first. A skill-gated tool will refuse until its skill is loaded.

USER FLOW RULES:
- NEVER invent an id. If you need one, list_* first, then pick from the returned data.
- NEVER fabricate an endpoint, parameter, header, or URL — always ground from a skill or connector doc.
- WHEN YOU CANNOT GROUND a request — the tool you would need does not exist, the recipe is not verified, the tenant has no resource of the kind asked for — call \`cannot_help(reason, missing_capability?, suggest_alternative?)\` and stop. Do NOT emit prose that pretends the action happened ("I've prompted a form…", "I'll create…") and do NOT paste a placeholder template ("your-host.com", "[YOUR_KEY]"). cannot_help ends the turn cleanly and feeds the operator's capability-gap backlog.
- NEVER re-run a destructive tool_write without a new confirmation.
- For cleanup/revoke requests, use the explicit tools when available: \`delete_workflow\`, \`delete_connector\`, \`delete_knowledge_source\`, \`delete_subscription\`, \`delete_tunnel\`, \`revoke_api_key\`, \`revoke_portal_token\`.
- If a cleanup action is not exposed as a conversation tool (for example archiving a workflow), say it is unavailable in this conversation surface. Do NOT invent a UI, support path, database action, or hidden admin console.
- There is no generic Subkit web UI/dashboard for fallback guidance in this product surface. Only mention a surface if it is explicitly available through tools or current context.
- ALWAYS surface the \`audit_log\` row id to the user after a tenant_write.
- ALWAYS report partial failures explicitly — don't summarise "done" when some steps errored.
- When the user asks what they can do or what exists, ground the answer in real tenant state first: prefer \`get_engine_status\`, \`list_workflows\`, \`list_connectors\`, \`list_executions\`, or \`whoami\` over generic onboarding copy.
- \`delete_workflow\` is available in the conversation tool palette. Use it for workflow cleanup; do not claim deletion is unsupported when the tool exists.
- Workflow archiving is not exposed as a conversation tool today. If asked to archive, say that plainly and only offer delete_workflow when the user actually wants cleanup.
- Subkit's HTTP API facts: the live OpenAPI contract is at \`/openapi.json\`, the interactive docs are at \`/docs\`, and exact routes must be grounded in the live contract or the actual route definitions. Do not invent endpoints.
- Subkit's MCP facts: use Streamable HTTP at \`/mcp\` or the stdio proxy via \`subkit mcp\`. Do not mention the deprecated SSE MCP transport as a supported path.
- Google Chat is a first-class chat adapter. Using it as a conversation surface requires chat workspace install plus \`/subkit link\` identity linking.
- The engine has scheduled workflow execution, but schedule-management conversation tools are not exposed in this chat surface today. Do not invent working schedule endpoints or claim schedule creation works here unless a real tool exposes it.

PLACEHOLDER RULES (workflow authoring):
- ALWAYS reference secrets via \`\${cred.<slug>.<field>}\` — never inline an API key, token, or password. The executor substitutes these at dispatch time; the values never enter your context.
- Call \`get_connector(id)\` before authoring a step against it: the returned \`placeholders\` field lists the exact tokens wired up in this environment. Use those, do not guess field names.
- Use \`\${connector.<slug>.base_url}\` to reference URLs and \`\${connector.<slug>.config.<path>}\` for arbitrary config (regions, feature flags, versions).
- Use \`\${input.<path>}\` for workflow input and \`\${scope.<step_id>.<path>}\` for prior-step outputs. The output envelope is \`{data, status_code?, headers?, error?, duration_ms}\` — prior-step data lives at \`\${scope.<step>.data}\`, NEVER bare \`\${scope.<step>}\`.
- The \`build_workflow\` tool refuses to persist a draft whose placeholder references do not resolve against the target environment — read \`details.problems\` and fix the tokens listed before retrying.

ATTACHMENT HANDLING:
- When the user uploads a file (OpenAPI spec, CSV sample, notes), it appears in the attachments list and can be referenced in any tool input as \`@attachment:<slug>\`. The engine resolves the marker before the tool runs, so strings that are exactly \`@attachment:<slug>\` get the full file content and strings that merely contain the marker get inline substitution.
- Do NOT paste raw file content into tool inputs or chat; prefer the slug reference so the context budget stays small and the full body reaches the tool untouched.

ERROR RECOVERY:
- Tool errors have a typed code. Common ones: \`placeholder_unresolved\` (read \`details.unresolved\` for the token names), \`permission_denied\` (read \`details.permission\`, do not retry), \`placeholder_connector_missing\` (the slug is wrong or wrong env), \`connector_not_found\`, \`http_5xx\`, \`http_4xx\`, \`step_timeout\`, \`validation_failed\`.
- Recovery routine: (1) read the error body, (2) \`load_skill(<matching-slug>)\` if you need deeper knowledge, (3) \`search_knowledge\` for vendor-specific notes, (4) \`probe_connector\` to diagnose at the connector boundary, (5) edit the draft and re-run. Do not retry the same tool with the same input.

ACCESS RULES (RBAC):
- If a tool returns \`{ok: false, data: { error: "permission_denied" }}\`, explain that the current role does not permit this request. Do NOT suggest workarounds; the user should contact an admin.
- Never attempt to bypass a denied tool by rephrasing the request.

AUDIT + ELICITATION:
- Every tenant_write you execute writes an audit_log entry via the tool. Surface that back.
- ask_user_confirm pauses the loop until the operator answers. On \`confirmed\`: proceed. On \`declined\`: explain the next option. On \`partial\`: apply only the approved subset.

WORKFLOW STEP KINDS (for propose_step / update_param):
- A workflow has \`steps[]\`. Each step has a unique \`id\` and a \`kind\`. The discriminator is ALWAYS \`kind\` — never \`type\`, \`@type\`, \`step_type\`, or invented namespaces (\`trigger.*\`, \`flow.*\`, \`util.*\`).
- Valid kinds (8 total) and their required fields:
  - \`request\`: id, kind, (url OR connector_id) — HTTP / GraphQL / connector calls
  - \`transform\`: id, kind, expression — JSONata or JS data shaping
  - \`call\`: id, kind, (workflow_id OR workflow_slug) — invoke another workflow
  - \`wait\`: id, kind, duration_ms — sleep
  - \`branch\`: id, kind, when, then_steps — conditional fan-out (children referenced by id)
  - \`parallel\`: id, kind, branches — parallel arms (each arm an array of step ids)
  - \`loop\`: id, kind, over, body — iterate, body referenced by id
  - \`tool\`: id, kind, image — sandboxed container step
- Approvals / human gates: there is NO \`approval\` kind. Use \`ask_user_confirm\` (during authoring) or model the human gate as a \`request\` to your approval system + a \`branch\` on its outcome.
- If propose_step returns ok=false, read the \`valid_kinds\`, \`required_fields_for_kind\`, and \`example_for_kind\` fields and call propose_step again with the corrected shape.

VERBOSITY:
- ${verbosity}

CONVERSATIONAL AUTHORING:
- Always tell the user what stage they are in: connector setup, connector probe, workflow drafting, workflow preview, or save/commit.
- Ask concise, operator-friendly questions. Prefer multiple-choice style wording in prose over broad open-ended asks.
- After every important tool result, summarize what changed, what is still missing, and what the best next action is.
- Never tell the user a connector is ready before it has been probed, unless you explicitly explain why probing is not possible.
- Never force a template. Offer it, explain why it might help, and continue without it if the user declines.
- In \`sk_interactive\`, you may mention a built-in slash command when it is the fastest valid path for the user: \`/resume\`, \`/permissions\`, \`/status\`, or \`/help\`.
- For product-help and surface-help questions, answer from confirmed Subkit behavior first. Use short, operational instructions rather than speculative brainstorming.

TOOL INTERACTION LOGS:
- Tool results may include an \`interactionLog\` array recording user UI actions on that specific tool call. Treat it as immutable history. A \`user_tested\` entry does NOT mean the change was applied — only \`user_confirmed\` or \`user_partial\` mean applied.

SYSTEM KNOWLEDGE:
- Use skills and connector docs silently. Never say "as the skills say…"; just ground your output in them.`;
}

const BASE_SYSTEM_PROMPTS: Record<LlmFlow, string> = {
  generate: [
    "You are the subkit workflow engine's generate flow.",
    "Turn the user's description into a typed WorkflowDef draft.",
    "A WorkflowDef has a `name`, optional `slug` / `description`, and an ordered `steps[]` array.",
    "Each step has `kind` (one of: request, transform, call, wait, branch, parallel, loop, tool) and a unique `id`.",
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
  // `converse` is replaced dynamically per-surface via converseBasePrompt.
  // The constant here is only used when no surface is supplied.
  converse: converseBasePrompt("sk_interactive"),
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
};

/** Return the system prompt for a flow, honouring the conversation surface. */
export function basePromptFor(flow: LlmFlow, surface?: ConversationSurface): string {
  if (flow === "converse" && surface) return converseBasePrompt(surface);
  return BASE_SYSTEM_PROMPTS[flow];
}

function formatSkill(s: Skill): string {
  const bp = s.best_practices.length > 0 ? `\nBest practices: ${s.best_practices.join("; ")}` : "";
  const pit = s.pitfalls.length > 0 ? `\nPitfalls: ${s.pitfalls.join("; ")}` : "";
  const refs = s.doc_refs.length > 0 ? `\nDoc refs: ${s.doc_refs.join(", ")}` : "";
  const ex = s.examples.length > 0 ? `\nExamples:\n- ${s.examples.join("\n- ")}` : "";
  return `# Skill: ${s.title} (${s.scope})\n${s.body}${bp}${pit}${refs}${ex}`;
}

function formatChunk(chunk: IncludedChunk): string {
  const heading = chunk.title
    ? `## Doc: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Doc: ${chunk.path}`
      : "## Doc";
  return `${heading}\n${chunk.snippet}`;
}

function formatKnowledgeChunk(chunk: IncludedKnowledgeChunk): string {
  const heading = chunk.title
    ? `## Knowledge: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Knowledge: ${chunk.path}`
      : "## Knowledge";
  return `${heading}\n${chunk.snippet}`;
}

function formatFailure(f: PriorFailure): string {
  const parts = [`## Prior failure: ${f.step_id}`, f.error];
  if (f.schema_diff) parts.push(`schema diff:\n${f.schema_diff}`);
  if (f.captured_response) parts.push(`captured response:\n${f.captured_response}`);
  return parts.join("\n");
}

function formatUserMemory(s: string): string {
  return `# User memory\n${s}`;
}

function buildQuery(turns: UserTurn[]): string {
  const tail = turns.slice(-3).map((t) => t.content);
  return tail.join(" ").slice(0, 512);
}

async function loadChunks(
  tenant_id: string,
  connector_id: string | undefined,
  query: string,
  exec: Executor,
): Promise<IncludedChunk[]> {
  if (!connector_id || !query) return [];
  try {
    const hits = await searchDocs({ tenant_id, connector_id, query, limit: 10 }, exec);
    return hits.map((h) => ({
      id: h.id,
      document_id: h.document_id,
      title: h.title,
      path: h.path,
      snippet: h.snippet,
      rank: h.rank,
      tokens: countTokens(h.snippet),
    }));
  } catch (err) {
    logger.debug({
      module: "llm",
      action: "llm.context.doc_search_skipped",
      msg: "doc search failed during context assembly",
      tenant_id,
      connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function loadKnowledgeChunks(
  tenant_id: string,
  workflow_id: string | undefined,
  query: string,
  exec: Executor,
): Promise<IncludedKnowledgeChunk[]> {
  if (!query) return [];
  try {
    const hits = await searchKnowledge(
      { tenant_id, query, ...(workflow_id ? { workflow_id } : {}), limit: 10 },
      exec,
    );
    return hits.map((h) => ({
      id: h.id,
      knowledge_source_id: h.knowledge_source_id,
      title: h.title,
      path: h.path,
      snippet: h.snippet,
      rank: h.rank,
      tokens: countTokens(h.snippet),
    }));
  } catch (err) {
    logger.debug({
      module: "llm",
      action: "llm.context.knowledge_search_skipped",
      msg: "knowledge search failed during context assembly",
      tenant_id,
      workflow_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface BudgetReport {
  cap_tokens: number;
  total_tokens: number;
  stable_tokens: number;
  volatile_tokens: number;
  messages_tokens: number;
  included: {
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
  };
  /** Sections dropped by the trimmer, in order. Empty = fit comfortably. */
  dropped_sections: string[];
}

export interface AssembledContext {
  prompt: EnhancedPrompt;
  blocks: CacheBlocks;
  budget_report: BudgetReport;
}

/**
 * Assemble an EnhancedPrompt for the given tenant + flow. Enforces a
 * token budget against the effective model's context cap and drops
 * lowest-priority sections first when the prompt overflows. Throws
 * LlmContextTooLarge only when *even* the base system prompt does not fit
 * — i.e. all optional context has been dropped.
 */
export async function assembleEnhancedPrompt(
  p: AssembleContextParams & { surface?: ConversationSurface },
  exec?: Executor,
): Promise<EnhancedPrompt & { dropped_sections: string[] }> {
  const db = exec ?? getDb();
  const cap = Math.min(p.max_tokens, contextCapFor(p.model ?? "default"));

  const baseSystem = basePromptFor(p.flow, p.surface);
  const skillsApplicable = await retrieveApplicableSkills(
    {
      tenant_id: p.tenant_id,
      ...(p.connector_id ? { connector_ids: [p.connector_id] } : {}),
      ...(p.workflow_id ? { workflow_ids: [p.workflow_id] } : {}),
    },
    db,
  );

  const globalSkills = skillsApplicable.filter((s) => s.scope === "global");
  const connectorSkills = skillsApplicable.filter((s) => s.scope === "connector");
  const workflowSkills = skillsApplicable.filter((s) => s.scope === "workflow");

  // On-demand skills (load_skill). Each slug is either a skill id or
  // title. We fetch by id first (fast path) and fall back to a titled
  // lookup via listSkills when the slug isn't a UUID. Skills already
  // covered by scope-based retrieval are de-duped by id.
  const loadedSkillSlugs = p.loaded_skill_slugs ?? [];
  const loadedSkills = [] as Skill[];
  if (loadedSkillSlugs.length > 0) {
    const existingIds = new Set(skillsApplicable.map((s) => s.id));
    const allTenantSkills = await listSkills({ tenant_id: p.tenant_id }, db);
    for (const slug of loadedSkillSlugs) {
      if (existingIds.has(slug)) continue;
      let match = allTenantSkills.find((s) => s.id === slug);
      if (!match) {
        match = allTenantSkills.find((s) => s.title.toLowerCase() === slug.toLowerCase());
      }
      if (!match) {
        // Last-resort by-id fetch — covers the case where listSkills
        // was paginated and the id isn't in the first page.
        const fetched = await getSkill(p.tenant_id, slug, db);
        if (fetched) match = fetched;
      }
      if (match && !existingIds.has(match.id)) {
        loadedSkills.push(match);
        existingIds.add(match.id);
      }
    }
  }

  const query = buildQuery(p.user_turns);

  // Knowledge chunks: 15% of token budget for enterprise domain knowledge.
  const knowledgeBudget = Math.floor(cap * 0.15);
  const rawKnowledgeChunks = await loadKnowledgeChunks(p.tenant_id, p.workflow_id, query, db);
  const knowledgeChunks: IncludedKnowledgeChunk[] = [];
  let knowledgeBytes = 0;
  for (const kc of rawKnowledgeChunks) {
    if (knowledgeBytes + kc.tokens > knowledgeBudget) break;
    knowledgeChunks.push(kc);
    knowledgeBytes += kc.tokens;
  }

  // Connector docs: 30% of token budget.
  const docsBudget = Math.floor(cap * 0.3);
  const rawChunks = await loadChunks(p.tenant_id, p.connector_id, query, db);
  const chunks: IncludedChunk[] = [];
  let docsBytes = 0;
  for (const ch of rawChunks) {
    if (docsBytes + ch.tokens > docsBudget) break;
    chunks.push(ch);
    docsBytes += ch.tokens;
  }

  let failures = p.prior_failures ?? [];
  let userMemory = typeof p.user_memory === "string" ? p.user_memory.trim() : "";
  let authoringContext = typeof p.authoring_context === "string" ? p.authoring_context.trim() : "";

  const runtimeBlock = p.runtime_context
    ? renderRuntimeContextBlock({
        ...(p.runtime_context.engine_url ? { engine_url: p.runtime_context.engine_url } : {}),
        ...(p.runtime_context.tenant_slug ? { tenant_slug: p.runtime_context.tenant_slug } : {}),
        ...(p.runtime_context.actor_email ? { actor_email: p.runtime_context.actor_email } : {}),
        ...(p.runtime_context.actor_role ? { actor_role: p.runtime_context.actor_role } : {}),
        ...(p.runtime_context.surface ? { surface: p.runtime_context.surface } : {}),
      })
    : null;

  const render = () => {
    const sections: string[] = [baseSystem];
    if (runtimeBlock) sections.push(runtimeBlock);
    for (const s of globalSkills) sections.push(formatSkill(s));
    for (const s of connectorSkills) sections.push(formatSkill(s));
    for (const s of workflowSkills) sections.push(formatSkill(s));
    for (const s of loadedSkills) sections.push(formatSkill(s));
    for (const kc of knowledgeChunks) sections.push(formatKnowledgeChunk(kc));
    if (userMemory) sections.push(formatUserMemory(userMemory));
    for (const c of chunks) sections.push(formatChunk(c));
    for (const f of failures) sections.push(formatFailure(f));
    // Authoring context lives at the tail so it stays in the volatile
    // cache segment — it changes every turn and must not invalidate the
    // stable prefix above.
    if (authoringContext) sections.push(authoringContext);
    return sections.join("\n\n");
  };

  let system = render();
  let systemTokens = countTokens(system);
  const messagesTokens = countMessagesTokens(p.user_turns);
  let total = systemTokens + messagesTokens;

  // Drop order (lowest priority dropped first):
  //   failures → connector docs → knowledge chunks → user memory →
  //   workflow skills → connector skills → global skills.
  const recount = () => {
    system = render();
    systemTokens = countTokens(system);
    total = systemTokens + messagesTokens;
  };

  const trimmed: string[] = [];
  while (total > cap) {
    if (failures.length > 0) {
      failures = [];
      trimmed.push("failures");
    } else if (chunks.length > 0) {
      chunks.pop();
      trimmed.push("docs");
    } else if (knowledgeChunks.length > 0) {
      knowledgeChunks.pop();
      trimmed.push("knowledge");
    } else if (userMemory) {
      userMemory = "";
      trimmed.push("user_memory");
    } else if (authoringContext) {
      authoringContext = "";
      trimmed.push("authoring_context");
    } else if (loadedSkills.length > 0) {
      loadedSkills.pop();
      trimmed.push("loaded_skill");
    } else if (workflowSkills.length > 0) {
      workflowSkills.pop();
      trimmed.push("workflow_skill");
    } else if (connectorSkills.length > 0) {
      connectorSkills.pop();
      trimmed.push("connector_skill");
    } else if (globalSkills.length > 0) {
      globalSkills.pop();
      trimmed.push("global_skill");
    } else {
      logger.error({
        module: "llm",
        action: "context.overflow",
        msg: "prompt exceeds model context window after trimming",
        tenant_id: p.tenant_id,
        flow: p.flow,
        model: p.model ?? null,
        total,
        cap,
        trimmed,
      });
      throw new LlmContextTooLarge("prompt exceeds model context window after trimming", {
        total,
        cap,
      });
    }
    recount();
  }

  if (trimmed.length > 0) {
    logger.warn({
      module: "llm",
      action: "context.trimmed",
      msg: "context assembly dropped sections to fit model cap",
      tenant_id: p.tenant_id,
      flow: p.flow,
      model: p.model ?? null,
      cap,
      total_after: total,
      dropped: trimmed,
    });
  }

  const includedSkills = [...globalSkills, ...connectorSkills, ...workflowSkills, ...loadedSkills];
  return {
    system,
    messages: p.user_turns,
    token_counts: {
      system: systemTokens,
      skills: includedSkills.reduce((t, s) => t + countTokens(formatSkill(s)), 0),
      knowledge: knowledgeChunks.reduce((t, kc) => t + kc.tokens, 0),
      docs: chunks.reduce((t, c) => t + c.tokens, 0),
      failures: failures.reduce((t, f) => t + countTokens(formatFailure(f)), 0),
      messages: messagesTokens,
      total,
    },
    included_skill_ids: includedSkills.map((s) => s.id),
    included_chunk_ids: chunks.map((c) => c.id),
    included_knowledge_chunk_ids: knowledgeChunks.map((kc) => kc.id),
    included_skills: includedSkills,
    included_chunks: chunks,
    included_knowledge_chunks: knowledgeChunks,
    dropped_sections: trimmed,
  };
}

/**
 * Detect which auto-load skills match the current conversation context.
 * Matching is deterministic: checks attachment MIME types and message
 * keywords against skill `trigger_keywords`. No LLM call.
 *
 * Returns skill slugs (ids or titles) to append to `loaded_skill_slugs`.
 */
export async function detectIntentSkills(
  tenant_id: string,
  opts: {
    attachmentMimeTypes?: string[];
    userMessage?: string;
    hasFailedExecution?: boolean;
    hasMultipleConnectors?: boolean;
  },
  exec?: Executor,
): Promise<string[]> {
  const keywords: string[] = [];

  for (const mime of opts.attachmentMimeTypes ?? []) {
    const lower = mime.toLowerCase();
    if (lower.includes("openapi") || lower.includes("yaml") || lower.includes("json")) {
      keywords.push("openapi", "swagger", "yaml", "json");
    }
    if (lower === "application/pdf" || lower.includes("pdf")) keywords.push("pdf");
    if (lower.startsWith("image/")) keywords.push("image", "screenshot", "png", "jpg");
    if (lower.includes("postman")) keywords.push("postman");
    if (lower.includes("graphql") || lower.includes("gql")) keywords.push("graphql");
    if (lower.includes("har")) keywords.push("har");
  }

  const msg = (opts.userMessage ?? "").toLowerCase();
  if (msg.includes("openapi") || msg.includes("swagger")) keywords.push("openapi");
  if (msg.includes("postman")) keywords.push("postman");
  if (msg.includes("graphql")) keywords.push("graphql");
  // External MCP-client integration intents — Codex / Claude Code / Claude
  // Desktop / Cursor / Continue. Loads `mcp-codex-integration` (and any
  // sibling vendor-specific Skills authored later) so the assistant has a
  // grounded recipe before it speaks.
  if (msg.includes("mcp") || msg.includes("codex") || msg.includes("claude code") || msg.includes("claude desktop")) {
    keywords.push("mcp", "codex", "claude code", "claude desktop", "model context protocol");
  }
  if (opts.hasFailedExecution) keywords.push("troubleshoot", "failure", "error");
  if (opts.hasMultipleConnectors) keywords.push("multi-connector", "orchestration");
  if (keywords.length === 0) keywords.push("onboarding");

  const matched = await listAutoLoadSkills(tenant_id, [...new Set(keywords)], exec);
  return matched.map((s) => s.id);
}

/**
 * High-level entry point — wraps `assembleEnhancedPrompt` with the
 * stable/volatile cache-block split and a structured `BudgetReport`.
 * `core/invoke.ts` uses this before dispatching to the AiSdkModel.
 */
export async function assembleContext(
  params: AssembleContextParams,
  exec?: Executor,
): Promise<AssembledContext> {
  const prompt = await assembleEnhancedPrompt(params, exec);
  const blocks = splitPromptIntoBlocks(prompt, params.flow);

  const { dropped_sections, ...promptWithoutDropped } = prompt;

  return {
    prompt: promptWithoutDropped,
    blocks,
    budget_report: {
      cap_tokens: params.max_tokens,
      total_tokens: prompt.token_counts.total,
      stable_tokens: blocks.token_counts.stable,
      volatile_tokens: blocks.token_counts.volatile,
      messages_tokens: prompt.token_counts.messages,
      included: {
        skills: prompt.included_skill_ids.length,
        knowledge: prompt.included_knowledge_chunk_ids.length,
        docs: prompt.included_chunk_ids.length,
        failures: (params.prior_failures ?? []).length,
      },
      dropped_sections,
    },
  };
}
