import { getConfig } from "../config/loader.ts";

// RuntimeContext — per-turn ground truth about the engine, tenant
// and actor that the LLM is responding to.
//
// The block this module renders is injected into the system prompt by
// `assembleEnhancedPrompt`. Without it, the model has no honest way to
// know its own host URL or the calling actor's identity, and falls
// back to placeholders ("your-subkit-instance.com", "<YOUR_KEY>") when
// asked to produce a paste-ready config.
//
// The shape is deliberately minimal — only values that the LLM should
// quote verbatim live here. Anything richer (workflow IDs, connector
// IDs, vendor recipes) goes into its own manifest module.

export interface RuntimeContext {
  /** Public origin (`https://host[:port]`) the engine is reachable at. */
  engine_url?: string;
  /** Tenant slug shown alongside the host so the model can refer to it. */
  tenant_slug?: string;
  /** Calling actor's email — humans only; system accounts are unset. */
  actor_email?: string;
  /** Calling actor's role name (e.g. "operator", "admin", "end_user"). */
  actor_role?: string;
  /** Conversation surface (sk_headless / sk_interactive / mcp / web). */
  surface?: string;
  /**
   * Permission mode for this turn (`auto` / `ask` / `plan` / `yolo`).
   * The PERMISSION-MODE-AWARE CONFIRMATION rule in the base prompt
   * branches on this value: in `auto`, the model skips
   * ask_user_confirm for non-dangerous tenant_writes; in `ask`/`plan`,
   * every tenant_write still flows through ask_user_confirm; in
   * `yolo` (operator-armed escape hatch) the engine itself short-
   * circuits the gate, so the model still emits the call exactly as
   * it would in `auto` and the engine accepts it.
   */
  permission_mode?: "auto" | "ask" | "plan" | "yolo";
}

/**
 * Render the runtime-context block injected into the system prompt.
 * Returns null when no real context is available — the assembler then
 * skips the block entirely instead of emitting an empty header that
 * would burn cache space.
 */
export function renderRuntimeContextBlock(ctx: RuntimeContext): string | null {
  const lines: string[] = [];
  if (ctx.engine_url) lines.push(`- engine_url: ${ctx.engine_url}`);
  if (ctx.tenant_slug) lines.push(`- tenant_slug: ${ctx.tenant_slug}`);
  if (ctx.actor_email) lines.push(`- actor_email: ${ctx.actor_email}`);
  if (ctx.actor_role) lines.push(`- actor_role: ${ctx.actor_role}`);
  if (ctx.surface) lines.push(`- surface: ${ctx.surface}`);
  if (ctx.permission_mode) lines.push(`- permission_mode: ${ctx.permission_mode}`);
  if (lines.length === 0) return null;
  return [
    "RUNTIME CONTEXT (real values for this turn — quote verbatim, never paraphrase):",
    ...lines,
    "",
    "Rules:",
    "- When you need to reference this engine's URL in any artifact (HTTP request, MCP config, SDK snippet, runbook), use the literal `engine_url` value above. NEVER write `your-subkit-instance.com`, `example.com`, `<YOUR_HOST>`, or similar placeholders.",
    '- If `engine_url` is missing from this block, you do NOT know the host — call `cannot_help(reason: "engine_url is not exposed in this turn\'s runtime context", missing_capability: "manifest.runtime_context.engine_url")` instead of inventing one.',
    "- The `tenant_slug` and `actor_email` may be quoted in human-friendly text but never used as path segments unless the user explicitly asked.",
  ].join("\n");
}

/**
 * Resolve the engine's public URL from configuration alone — no request
 * needed. Used by the origin-less surfaces (Google Chat runs in an async
 * queue job; MCP background turns have no HTTP origin to trust). Reads
 * canonical `server.public_base_url`, otherwise returns `undefined`.
 *
 * This is the authoritative public URL for those surfaces — set
 * `server.public_base_url` in prod or the model has no honest URL to quote
 * and (correctly) refuses to invent one.
 */
export function engineUrlFromConfig(): string | undefined {
  try {
    const cfg = getConfig().server.public_base_url;
    if (cfg && cfg.length > 0) return cfg;
  } catch {
    /* loader not initialised */
  }
  return undefined;
}

/**
 * Resolve a request's public origin into an `engine_url` string. Order:
 *   1) `req.url` origin (the host the caller actually reached).
 *   2) canonical `config.server.public_base_url` (see `engineUrlFromConfig`).
 *   3) `undefined` — caller decides to fall back or omit.
 */
export function resolveEngineUrl(req: Request | { url: string }): string | undefined {
  try {
    const origin = new URL(req.url).origin;
    if (origin && origin !== "null") return origin;
  } catch {
    /* fall through */
  }
  return engineUrlFromConfig();
}
