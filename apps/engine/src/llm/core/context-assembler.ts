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

import { getConnector } from "../../connectors/service.ts";
import { generateMainAgentSystemPrompt } from "../../conversations/agent/context.ts";
import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { searchDocs } from "../../docs-ingestion/service.ts";
import { searchKnowledge } from "../../knowledge/service.ts";
import { logger } from "../../logging/logger.ts";
import { recordLlmContextAssembled } from "../../observability/instrumentation.ts";
import {
  getSkill,
  getSkillBySlug,
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
  AuthoringPromptHint,
  EnhancedPrompt,
  IncludedChunk,
  IncludedKnowledgeChunk,
  LlmFlow,
  PriorFailure,
  UserTurn,
} from "../types.ts";
import { type CacheBlocks, splitPromptIntoBlocks } from "./cache-blocks.ts";
import { loadTenantSummary, renderTenantSummaryBlock } from "./tenant-summary.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web";

// Live-data assembly only. The structural prompt body (persona,
// behaviour skills, authoring-focus blocks) is owned by the agent
// registry — see `apps/engine/src/conversations/agent/context.ts`.
//
// `basePromptFor` and `BASE_SYSTEM_PROMPTS` remain the entry point
// for one-shot flows (`generate`, `extract`, `repair`, `summarize`,
// `discover`) that don't go through the conversation agent. The
// `converse` flow asks the MAIN agent registry for its system prompt
// instead — `assembleEnhancedPrompt` calls
// `generateMainAgentSystemPrompt` and uses the result verbatim.

const BASE_SYSTEM_PROMPTS: Record<Exclude<LlmFlow, "converse">, string> = {
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

/**
 * Return the system prompt body for a one-shot flow. The `converse`
 * flow does NOT pass through this — it asks the agent registry for
 * its prompt directly. We keep the function exported with a `converse`
 * branch only so legacy callers (tests, eval fixtures) that ask for
 * the converse base get a small helpful fallback rather than throwing.
 */
export async function basePromptFor(
  flow: LlmFlow,
  surface?: ConversationSurface,
  authoringHint?: AuthoringPromptHint,
): Promise<string> {
  if (flow === "converse") {
    const result = await generateMainAgentSystemPrompt({
      ...(surface ? { surface } : {}),
      ...(authoringHint ? { authoring_hint: authoringHint } : {}),
    });
    return result.content;
  }
  return BASE_SYSTEM_PROMPTS[flow];
}

/**
 * Substitute whitelisted runtime-context tokens in a skill body at
 * assembly time, so the model never sees a `${engine_url}`-style
 * template it has to resolve itself. Only tokens whose keys match a
 * known runtime-context field are replaced; unknown tokens (e.g.
 * `${plaintext_key}`, `${cred.slack.token}`, `${input.path}`) are
 * passed through unchanged — the skill author still controls what
 * stays as a placeholder for the user to fill in later.
 *
 * Mirrors the pattern used by Anthropic's Claude Code CLI: concrete
 * environment values are pre-rendered into the system prompt once,
 * rather than leaving it to the model to splice runtime data.
 */
export function applyRuntimeTemplate(
  body: string,
  ctx?: AssembleContextParams["runtime_context"],
): string {
  if (!ctx || !body.includes("${")) return body;
  const subs: Record<string, string | undefined> = {
    engine_url: ctx.engine_url,
    tenant_slug: ctx.tenant_slug,
    actor_email: ctx.actor_email,
    actor_role: ctx.actor_role,
    surface: ctx.surface,
  };
  return body.replace(/\$\{([a-z_]+)\}/g, (whole, key: string) => {
    const value = subs[key];
    return typeof value === "string" && value.length > 0 ? value : whole;
  });
}

function formatSkill(s: Skill, runtime_context?: AssembleContextParams["runtime_context"]): string {
  const body = applyRuntimeTemplate(s.body, runtime_context);
  const bp = s.best_practices.length > 0 ? `\nBest practices: ${s.best_practices.join("; ")}` : "";
  const pit = s.pitfalls.length > 0 ? `\nPitfalls: ${s.pitfalls.join("; ")}` : "";
  const refs = s.doc_refs.length > 0 ? `\nDoc refs: ${s.doc_refs.join(", ")}` : "";
  const ex = s.examples.length > 0 ? `\nExamples:\n- ${s.examples.join("\n- ")}` : "";
  return `# Skill: ${s.title} (${s.scope})\n${body}${bp}${pit}${refs}${ex}`;
}

function fetchedAtSuffix(fetched_at: string | null): string {
  if (!fetched_at) return "";
  // Trim to YYYY-MM-DD so the prompt header is compact and stable.
  const date = fetched_at.slice(0, 10);
  return ` (fetched ${date})`;
}

/**
 * Operator-supplied per-connector notes — short, imperative hints the
 * operator wants the model to treat as authoritative ("treat 422 as
 * success on /upsert", "always send `?api-version=2025-01-01`"). Lives
 * in `connectors.operator_notes`. The block is opt-in (only rendered
 * when the connector row carries a non-empty value) and stays in the
 * stable head so it caches alongside skills.
 *
 * Format keeps the connector slug + name visible so the model never
 * confuses notes from two connectors that ended up in scope on the
 * same turn.
 */
function formatOperatorNotes(slug: string, name: string, notes: string): string {
  return `# Operator notes — connector \`${slug}\` (${name})\n${notes}`;
}

function formatChunk(chunk: IncludedChunk): string {
  const heading = chunk.title
    ? `## Doc: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Doc: ${chunk.path}`
      : "## Doc";
  return `${heading}${fetchedAtSuffix(chunk.fetched_at)}\n${chunk.snippet}`;
}

function formatKnowledgeChunk(chunk: IncludedKnowledgeChunk): string {
  const heading = chunk.title
    ? `## Knowledge: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Knowledge: ${chunk.path}`
      : "## Knowledge";
  return `${heading}${fetchedAtSuffix(chunk.fetched_at)}\n${chunk.snippet}`;
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
      fetched_at: h.fetched_at,
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
      fetched_at: h.fetched_at,
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

  const baseSystem = await basePromptFor(p.flow, p.surface, p.authoring_hint);
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

  // On-demand skills (load_skill). Each entry is a slug, an id, or a
  // title. Resolution order is slug → id → title — slug first because
  // `loaded_skill_slugs` literally carries slugs from the seed-loader
  // and the auto-loaded authoring constants (loop.ts). Last-resort fetch
  // routes by shape so a bare slug never hits the uuid-typed id column.
  const loadedSkillSlugs = p.loaded_skill_slugs ?? [];
  const loadedSkills = [] as Skill[];
  if (loadedSkillSlugs.length > 0) {
    const existingIds = new Set(skillsApplicable.map((s) => s.id));
    const allTenantSkills = await listSkills({ tenant_id: p.tenant_id }, db);
    for (const ref of loadedSkillSlugs) {
      if (existingIds.has(ref)) continue;
      let match =
        allTenantSkills.find((s) => s.slug === ref) ??
        allTenantSkills.find((s) => s.id === ref) ??
        allTenantSkills.find((s) => s.title.toLowerCase() === ref.toLowerCase());
      if (!match) {
        // Pagination escape hatch: listSkills caps at 500 rows.
        const fetched = UUID_RE.test(ref)
          ? await getSkill(p.tenant_id, ref, db)
          : await getSkillBySlug(p.tenant_id, ref, db);
        if (fetched) match = fetched;
      }
      if (match && !existingIds.has(match.id)) {
        loadedSkills.push(match);
        existingIds.add(match.id);
      }
    }
  }

  const query = buildQuery(p.user_turns);

  // Knowledge + connector-docs embedding is now on-demand for the
  // `converse` flow. The model fetches them via the `search_knowledge`
  // and `fetch_connector_docs` tools only when the turn actually needs
  // them. The one-shot flows (generate / repair / extract / discover /
  // summarize) still pre-embed because they do not have a tool loop to
  // pull context at runtime. Without this split, every trivial read in
  // a conversation paid the full 15 % knowledge + 30 % docs tax
  // regardless of relevance (observed in session 4e6696e3: 1.1 M tokens
  // for a four-row list_workflows).
  const preEmbedCorpus = p.flow !== "converse";
  const knowledgeChunks: IncludedKnowledgeChunk[] = [];
  const chunks: IncludedChunk[] = [];
  if (preEmbedCorpus) {
    const knowledgeBudget = Math.floor(cap * 0.15);
    const rawKnowledgeChunks = await loadKnowledgeChunks(p.tenant_id, p.workflow_id, query, db);
    let knowledgeBytes = 0;
    for (const kc of rawKnowledgeChunks) {
      if (knowledgeBytes + kc.tokens > knowledgeBudget) break;
      knowledgeChunks.push(kc);
      knowledgeBytes += kc.tokens;
    }

    const docsBudget = Math.floor(cap * 0.3);
    const rawChunks = await loadChunks(p.tenant_id, p.connector_id, query, db);
    let docsBytes = 0;
    for (const ch of rawChunks) {
      if (docsBytes + ch.tokens > docsBudget) break;
      chunks.push(ch);
      docsBytes += ch.tokens;
    }
  }

  let failures = p.prior_failures ?? [];
  let userMemory = typeof p.user_memory === "string" ? p.user_memory.trim() : "";
  let authoringContext = typeof p.authoring_context === "string" ? p.authoring_context.trim() : "";

  // Operator notes for the in-scope connector. Loaded once per assembly
  // and rendered as a stable cache block adjacent to connector skills.
  // The field is hard-capped at 4 KB by the route schema, so the worst-
  // case token cost is small and we drop it only after every other
  // optional connector context block is gone.
  let connectorOperatorNotesBlock: string | null = null;
  if (p.connector_id) {
    try {
      const connector = await getConnector(p.tenant_id, p.connector_id, db);
      const trimmed = connector?.operator_notes?.trim() ?? "";
      if (connector && trimmed) {
        connectorOperatorNotesBlock = formatOperatorNotes(
          connector.slug,
          connector.display_name,
          trimmed,
        );
      }
    } catch (err) {
      logger.debug({
        module: "llm",
        action: "llm.context.operator_notes_skipped",
        msg: "operator_notes load failed during context assembly",
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const runtimeBlock = p.runtime_context
    ? renderRuntimeContextBlock({
        ...(p.runtime_context.engine_url ? { engine_url: p.runtime_context.engine_url } : {}),
        ...(p.runtime_context.tenant_slug ? { tenant_slug: p.runtime_context.tenant_slug } : {}),
        ...(p.runtime_context.actor_email ? { actor_email: p.runtime_context.actor_email } : {}),
        ...(p.runtime_context.actor_role ? { actor_role: p.runtime_context.actor_role } : {}),
        ...(p.runtime_context.surface ? { surface: p.runtime_context.surface } : {}),
      })
    : null;

  // Tenant snapshot block — concise list of workflows + connectors so
  // the model can answer "what do I have?" without round-tripping via
  // list_* tools. Only for the converse flow; one-shot flows do not
  // need it.
  const tenantSummaryBlock =
    p.flow === "converse"
      ? renderTenantSummaryBlock(await loadTenantSummary(p.tenant_id, db))
      : null;

  const render = () => {
    const sections: string[] = [];
    // Tenant snapshot appears at BOTH ends of the stable head:
    //   1) immediately before the base prompt so the model reads it
    //      first on the initial pass, and
    //   2) again at the tail (just before the volatile segment) so it
    //      is the most recent context before the user turn.
    // The duplication costs a few hundred tokens but reliably beats
    // the 85k-of-skills wall where a mid-prompt snapshot gets ignored.
    if (tenantSummaryBlock) sections.push(tenantSummaryBlock);
    sections.push(baseSystem);
    if (runtimeBlock) sections.push(runtimeBlock);
    for (const s of globalSkills) sections.push(formatSkill(s, p.runtime_context));
    if (connectorOperatorNotesBlock) sections.push(connectorOperatorNotesBlock);
    for (const s of connectorSkills) sections.push(formatSkill(s, p.runtime_context));
    for (const s of workflowSkills) sections.push(formatSkill(s, p.runtime_context));
    for (const s of loadedSkills) sections.push(formatSkill(s, p.runtime_context));
    for (const kc of knowledgeChunks) sections.push(formatKnowledgeChunk(kc));
    if (userMemory) sections.push(formatUserMemory(userMemory));
    for (const c of chunks) sections.push(formatChunk(c));
    for (const f of failures) sections.push(formatFailure(f));
    if (tenantSummaryBlock) sections.push(tenantSummaryBlock);
    // Authoring context lives at the very tail so it stays in the
    // volatile cache segment — it changes every turn and must not
    // invalidate the stable prefix above.
    if (authoringContext) sections.push(authoringContext);
    return sections.join("\n\n");
  };

  let system = render();
  let systemTokens = countTokens(system);
  const messagesTokens = countMessagesTokens(p.user_turns);
  let total = systemTokens + messagesTokens;

  // Drop order (lowest priority dropped first):
  //   failures → connector docs → knowledge chunks → user memory →
  //   authoring context → explicitly loaded skills → workflow skills →
  //   connector skills → global skills.
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
    } else if (connectorOperatorNotesBlock) {
      // operator_notes is the operator's direct, imperative instruction
      // for this connector — drop it only when nothing else remains
      // except global skills and the base prompt.
      connectorOperatorNotesBlock = null;
      trimmed.push("connector_operator_notes");
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
      skills: includedSkills.reduce(
        (t, s) => t + countTokens(formatSkill(s, p.runtime_context)),
        0,
      ),
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
  // External MCP-client integration intents — any MCP-aware client
  // (Codex, Claude Code, Claude Desktop, Cursor, Continue, Zed, Goose,
  // …). Loads the generic `mcp-server-setup` Skill; vendor-specific
  // config shapes live in the VendorRecipeManifest and are fetched
  // per-client via the `get_vendor_recipe` tool, not baked into prose.
  if (
    msg.includes("mcp") ||
    msg.includes("codex") ||
    msg.includes("claude code") ||
    msg.includes("claude desktop") ||
    msg.includes("cursor") ||
    msg.includes("continue") ||
    msg.includes("zed") ||
    msg.includes("goose")
  ) {
    keywords.push(
      "mcp",
      "mcp server",
      "mcp client",
      "model context protocol",
      "codex",
      "claude code",
      "claude desktop",
      "cursor",
      "continue",
      "zed",
      "goose",
    );
  }
  // Connector-creation intent. The `connector-creation-guidance` skill
  // was deliberately narrowed from a broad "api/http/endpoint" trigger
  // to creation-intent phrases only, so we match those phrases here.
  // Mentioning `create connector` / `new connector` pushes the checklist
  // skill; a user talking about an *existing* connector (or authoring
  // against one) does not pay the context cost.
  if (
    msg.includes("create connector") ||
    msg.includes("new connector") ||
    msg.includes("add connector") ||
    msg.includes("create a connector") ||
    msg.includes("add a connector") ||
    msg.includes("create integration") ||
    msg.includes("new integration") ||
    msg.includes("add integration") ||
    msg.includes("set up integration") ||
    msg.includes("configure connector") ||
    msg.includes("start connector")
  ) {
    keywords.push(
      "create connector",
      "new connector",
      "add connector",
      "add integration",
      "new integration",
      "set up integration",
      "configure connector",
      "start connector",
      "start_connector_from_description",
      "start_connector_from_template",
    );
  }
  // Execution-time failure diagnosis keywords — matches
  // `troubleshooting-workflow-failures.md`'s triggers. Pushed when the
  // loop's hasFailedExecution flag is set OR the user's message refers
  // to a past run.
  if (
    opts.hasFailedExecution ||
    msg.includes("execution failed") ||
    msg.includes("run failed") ||
    msg.includes("workflow failed") ||
    msg.includes("past run") ||
    msg.includes("circuit open") ||
    msg.includes("schema_violation") ||
    msg.includes("schema-violation")
  ) {
    keywords.push(
      "troubleshoot",
      "execution failed",
      "run failed",
      "workflow failed",
      "past run",
      "schema-violation",
      "circuit-breaker",
    );
  }
  // Authoring-time tool-error keywords — matches `error-recovery.md`'s
  // triggers. Pushed on explicit error shapes a user might paste OR the
  // model referencing its own failed tool call.
  if (
    msg.includes("error") ||
    msg.includes("failed") ||
    msg.includes("4xx") ||
    msg.includes("5xx") ||
    msg.includes("placeholder_unresolved") ||
    msg.includes("permission_denied") ||
    msg.includes("validation_failed") ||
    msg.includes("step_timeout") ||
    msg.includes("connector_not_found")
  ) {
    keywords.push(
      "error",
      "failed",
      "http_4xx",
      "http_5xx",
      "placeholder_unresolved",
      "permission_denied",
      "validation_failed",
      "step_timeout",
      "connector_not_found",
      "tool error",
    );
  }
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
  const effectiveCap = Math.min(params.max_tokens, contextCapFor(params.model ?? "default"));
  const includedFailureCount = prompt.dropped_sections.includes("failures")
    ? 0
    : (params.prior_failures ?? []).length;

  const { dropped_sections, ...promptWithoutDropped } = prompt;

  const budget_report = {
    cap_tokens: effectiveCap,
    total_tokens: prompt.token_counts.total,
    stable_tokens: blocks.token_counts.stable,
    volatile_tokens: blocks.token_counts.volatile,
    messages_tokens: prompt.token_counts.messages,
    included: {
      skills: prompt.included_skill_ids.length,
      knowledge: prompt.included_knowledge_chunk_ids.length,
      docs: prompt.included_chunk_ids.length,
      failures: includedFailureCount,
    },
    dropped_sections,
  };

  // Surface every assembly as a structured event. The metric and the
  // log line let operators see at a glance which flows are running
  // hot, which sections are getting trimmed, and how much of the
  // available cap is being spent.
  recordLlmContextAssembled({
    tenant_id: params.tenant_id,
    flow: params.flow,
    model: params.model ?? "default",
    cap_tokens: budget_report.cap_tokens,
    total_tokens: budget_report.total_tokens,
    stable_tokens: budget_report.stable_tokens,
    volatile_tokens: budget_report.volatile_tokens,
    messages_tokens: budget_report.messages_tokens,
    included: budget_report.included,
    dropped_sections: budget_report.dropped_sections,
  });

  return {
    prompt: promptWithoutDropped,
    blocks,
    budget_report,
  };
}
