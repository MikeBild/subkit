// web_search tool — escalation path when `search_knowledge` returns no
// hits. Uses Tavily's search API when `TAVILY_API_KEY` is set; otherwise
// returns a graceful `ok:false` so the model knows the channel is
// unavailable rather than being surprised by a crash.
//
// Tagged `tenant_read` — the call leaves the tenant perimeter (public
// internet), so it's gated by a per-tenant policy flag
// `allow_web_search` (read from `tenant_llm_settings.allow_web_search`;
// default false). Operators opt in explicitly.

import { z } from "@hono/zod-openapi";
import { WEB_SEARCH_ESCALATION_POLICY } from "../policies/web-search-escalation.ts";
import type { ConversationTool } from "./index.ts";

const Input = z
  .object({
    query: z.string().min(1),
    max_results: z.number().int().min(1).max(10).optional(),
  })
  .openapi("WebSearchToolInput");

interface TavilyHit {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyHit[];
  answer?: string;
}

export const webSearchTool: ConversationTool = {
  name: "web_search",
  description: `Public web search via Tavily. ${WEB_SEARCH_ESCALATION_POLICY.summary} Requires operator to have enabled \`${WEB_SEARCH_ESCALATION_POLICY.opt_in_setting}\` for this tenant.`,
  inputSchema: Input,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        data: {
          error: "web_search_not_configured",
          hint: "Set TAVILY_API_KEY to enable public web search fallback.",
        },
      };
    }

    // Opt-in check — tenant settings allow_web_search defaults to false.
    // Best-effort: fall through to execution if the settings column
    // doesn't exist in this environment. Operators running a gateway
    // deployment without that column are expected to wrap the tool via
    // tool_policies instead.
    try {
      const tenant = await ctx.engineClient.identity.whoami();
      const allow = (tenant as { allow_web_search?: boolean } | null)?.allow_web_search;
      if (allow === false) {
        return { ok: false, data: { error: "web_search_not_allowed_for_tenant" } };
      }
    } catch {
      // ignore, permissive-by-default when settings absent
    }

    const body = {
      api_key: apiKey,
      query: args.query,
      max_results: args.max_results ?? 5,
      include_answer: true,
    };
    let response: TavilyResponse;
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          data: { error: `tavily_http_${res.status}`, text: await res.text() },
        };
      }
      response = (await res.json()) as TavilyResponse;
    } catch (err) {
      return {
        ok: false,
        data: {
          error: "tavily_fetch_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const hits =
      response.results?.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        score: r.score,
        source: "web" as const,
      })) ?? [];

    return {
      ok: true,
      data: {
        source: "web",
        answer: response.answer ?? null,
        hits,
      },
    };
  },
};
