// Context Enhancement pipeline.
//
// Assembles the prompt from (base system prompt → global skills → connector
// skills → workflow skills → ingested connector docs → prior failures for
// repair → user turns) and enforces a per-tenant token budget via
// js-tiktoken. See docs/16-ai-flows.md for the full flow.

import type { Db } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import { searchDocs } from "../docs-ingestion/service.ts";
import { searchKnowledge } from "../knowledge/service.ts";
import { logger } from "../logging/logger.ts";
import { retrieveApplicableSkills } from "../skills/service.ts";
import type { Skill } from "../skills/types.ts";
import { LlmContextTooLarge } from "./errors.ts";
import { contextCapFor, countMessagesTokens, countTokens } from "./tokens.ts";
import type {
  AssembleContextParams,
  EnhancedPrompt,
  IncludedChunk,
  IncludedKnowledgeChunk,
  LlmFlow,
  PriorFailure,
  UserTurn,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const BASE_SYSTEM_PROMPTS: Record<LlmFlow, string> = {
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
  converse: [
    "You are the subkit workflow engine's converse flow.",
    "Hold a multi-turn authoring conversation with the operator.",
    "Ground every turn in the provided Skills and connector docs. Ask for clarification only when necessary.",
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
};

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

function buildQuery(turns: UserTurn[]): string {
  // Use the last few turns as a synthetic query for doc search.
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
    // Doc search is best-effort in the context pipeline. A search failure
    // (for example when the tsvector index is missing in a throwaway test
    // db) should not fail the flow.
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

/**
 * Assemble an EnhancedPrompt for the given tenant + flow. Enforces a
 * token budget against the effective model's context cap and drops
 * lowest-priority sections first when the prompt overflows.
 */
export async function assembleEnhancedPrompt(
  p: AssembleContextParams,
  exec?: Executor,
): Promise<EnhancedPrompt> {
  const db = exec ?? getDb();
  const cap = Math.min(p.max_tokens, contextCapFor(p.model ?? "default"));

  const baseSystem = BASE_SYSTEM_PROMPTS[p.flow];
  const skillsApplicable = await retrieveApplicableSkills(
    {
      tenant_id: p.tenant_id,
      ...(p.connector_id ? { connector_ids: [p.connector_id] } : {}),
      ...(p.workflow_id ? { workflow_ids: [p.workflow_id] } : {}),
    },
    db,
  );

  // Bucket skills by scope for the drop policy below.
  const globalSkills = skillsApplicable.filter((s) => s.scope === "global");
  const connectorSkills = skillsApplicable.filter((s) => s.scope === "connector");
  const workflowSkills = skillsApplicable.filter((s) => s.scope === "workflow");

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

  // User memory is an optional free-form payload sourced from the
  // caller's SUBKIT.md file. It lives between workflow skills and
  // ingested connector docs so it can influence grounding, and is
  // trimmed after failures + docs but before skills on overflow.
  let userMemory = typeof p.user_memory === "string" ? p.user_memory.trim() : "";
  const formatUserMemory = (s: string) => `# User memory\n${s}`;

  const render = () => {
    const sections: string[] = [baseSystem];
    for (const s of globalSkills) sections.push(formatSkill(s));
    for (const s of connectorSkills) sections.push(formatSkill(s));
    for (const s of workflowSkills) sections.push(formatSkill(s));
    for (const kc of knowledgeChunks) sections.push(formatKnowledgeChunk(kc));
    if (userMemory) sections.push(formatUserMemory(userMemory));
    for (const c of chunks) sections.push(formatChunk(c));
    for (const f of failures) sections.push(formatFailure(f));
    return sections.join("\n\n");
  };

  let system = render();
  let systemTokens = countTokens(system);
  const messagesTokens = countMessagesTokens(p.user_turns);
  let total = systemTokens + messagesTokens;

  // Drop order (lowest priority dropped first):
  //   failures → connector docs → knowledge chunks → user memory →
  //   workflow skills → connector skills → global skills.
  // User turns are never dropped (they are the call input).
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
      // Drop user memory AFTER docs/failures so grounding survives
      // overflow; before skills because skills are never trimmed
      // by contract (see docs/16-ai-flows.md).
      userMemory = "";
      trimmed.push("user_memory");
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

  const includedSkills = [...globalSkills, ...connectorSkills, ...workflowSkills];
  const prompt: EnhancedPrompt = {
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
  };
  return prompt;
}
