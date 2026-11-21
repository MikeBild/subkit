import { getConfig } from "../config/loader.ts";

interface RuntimeContext {
  engine_url?: string;
  tenant_slug?: string;
  actor_email?: string;
  actor_role?: string;
  surface?: string;
  ask_before_writing?: boolean;
}

export function renderRuntimeContextBlock(ctx: RuntimeContext): string | null {
  const lines: string[] = [];
  if (ctx.engine_url) lines.push(`- engine_url: ${ctx.engine_url}`);
  if (ctx.tenant_slug) lines.push(`- tenant_slug: ${ctx.tenant_slug}`);
  if (ctx.actor_email) lines.push(`- actor_email: ${ctx.actor_email}`);
  if (ctx.actor_role) lines.push(`- actor_role: ${ctx.actor_role}`);
  if (ctx.surface) lines.push(`- surface: ${ctx.surface}`);
  if (ctx.ask_before_writing) lines.push("- ask_before_writing: true");
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

export function engineUrlFromConfig(): string | undefined {
  try {
    const cfg = getConfig().server.public_base_url?.replace(/\/+$/, "");
    if (cfg && cfg.length > 0) return cfg;
  } catch {}
  return undefined;
}

export function resolveEngineUrl(req: Request | { url: string }): string | undefined {
  const configured = engineUrlFromConfig();
  if (configured) return configured;
  try {
    const origin = new URL(req.url).origin;
    if (origin && origin !== "null") return origin;
  } catch {}
  return undefined;
}
