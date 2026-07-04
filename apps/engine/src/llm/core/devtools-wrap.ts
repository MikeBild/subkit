// DevTools wrap.
//
// When NODE_ENV === "development" we wrap the resolved `LanguageModel` with
// `@ai-sdk/devtools`'s middleware so each `streamText`/`generateText` call
// is captured under `.devtools/` (auto-gitignored by the devtools package)
// and surfaced in the local viewer at `npx @ai-sdk/devtools`
// (port 4983). This is a developer-experience tool — it is opt-IN on an
// explicit development env, never enabled in prod / smoke / unset / staging
// contexts (the devtools writer is unbounded; an opt-out gate once grew a
// prod `.devtools/generations.json` to 684 MB — see isDevEnv() below).
//
// We compose two middlewares: a small header scrubber (outermost) so
// devtools never sees `Authorization` / `x-api-key` / `api-key` /
// `x-auth-token` / `x-amz-security-token` values, and the devtools
// middleware (innermost) which then writes the scrubbed call to
// `.devtools/generations.json`.
//
// `wrapLanguageModel` reverses the middleware array before composing, so
// the array [outer, inner] makes `outer` the user-facing wrapper —
// confirmed in node_modules/ai/dist/index.js (`reverse().reduce(...)`).

import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { wrapLanguageModel } from "ai";
import { logger } from "../../logging/logger.ts";

const REDACTED = "[REDACTED]";
const AUTH_HEADER_PATTERN =
  /^(authorization|x-api-key|api-key|x-auth-token|x-amz-security-token)$/i;

// Exported for the test suite (devtools-wrap.test.ts) so the redaction
// guarantee load-bearing on the design comment above can be asserted
// directly. Not part of the module's intended public API.
export const scrubAuthHeadersMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => {
    if (!params.headers) return params;
    const scrubbed: Record<string, string | undefined> = { ...params.headers };
    for (const key of Object.keys(scrubbed)) {
      if (AUTH_HEADER_PATTERN.test(key)) {
        scrubbed[key] = REDACTED;
      }
    }
    return { ...params, headers: scrubbed };
  },
};

// Explicit opt-IN on NODE_ENV === "development" — NOT opt-out via
// `!== "production"`. The opt-out form enabled the @ai-sdk/devtools writer
// (which appends every generation to cwd/.devtools/generations.json,
// unbounded) in EVERY context whose NODE_ENV wasn't exactly "production":
// smoke runs, an unset env, a staging tag, a future unit edit. On one production
// host that grew generations.json to 684 MB. The prod systemd unit sets
// NODE_ENV=production (never "development"), so this gate keeps devtools off
// in prod and any ambiguous context; a developer who wants the viewer runs
// with NODE_ENV=development.
const isDevEnv = (): boolean => process.env.NODE_ENV === "development";

let cachedDevtoolsMiddleware: LanguageModelV4Middleware | null | undefined;

// Dev-only optional dynamic import — `@ai-sdk/devtools` is a
// devDependency; in a production-pruned `node_modules` this resolves to
// `null` and we fall back to the unwrapped model. Matches the
// `await import(...)` convention used everywhere else in apps/engine/src/.
async function loadDevtoolsMiddleware(): Promise<LanguageModelV4Middleware | null> {
  if (cachedDevtoolsMiddleware !== undefined) return cachedDevtoolsMiddleware;
  try {
    const mod = (await import("@ai-sdk/devtools")) as {
      devToolsMiddleware: () => LanguageModelV4Middleware;
    };
    cachedDevtoolsMiddleware = mod.devToolsMiddleware();
  } catch (err) {
    cachedDevtoolsMiddleware = null;
    // First-time dev wonders why the viewer is empty — `info` so it
    // shows up in the default log stream without flipping to debug.
    // Path is dev-only (guarded above by isDevEnv()), so this never
    // fires in production.
    logger.info({
      module: "llm.devtools",
      action: "load_failed",
      msg: "@ai-sdk/devtools not loadable; continuing unwrapped",
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return cachedDevtoolsMiddleware;
}

/**
 * Reset the module-scoped middleware cache. Tests that flip `NODE_ENV`
 * between cases need this so a previously-cached load decision doesn't
 * leak between cases. Not part of the public API.
 */
export function __resetDevtoolsCacheForTests(): void {
  cachedDevtoolsMiddleware = undefined;
}

/**
 * Wrap a resolved language model with the DevTools middleware in
 * non-production environments. Returns the model unchanged in production
 * or when the model is the mock sentinel string. Composition:
 * [scrubAuthHeaders, devtools] — scrub is outermost so devtools captures
 * call params with Authorization-style headers redacted.
 */
export async function maybeWrapForDevtools(
  model: LanguageModel | string,
): Promise<LanguageModel | string> {
  if (typeof model === "string") return model;
  if (!isDevEnv()) return model;
  // wrapLanguageModel + the v4 middleware spec only accept LanguageModelV4.
  // Every provider subkit currently uses (anthropic/openai/google/azure/
  // bedrock/vertex/gateway) ships v4 models on AI SDK 7; the union with
  // V3/V2 in `ai`'s public type is for backwards compatibility, not active use.
  if (model.specificationVersion !== "v4") return model;
  const devtools = await loadDevtoolsMiddleware();
  if (!devtools) return model;
  return wrapLanguageModel({
    model: model as LanguageModelV4,
    middleware: [scrubAuthHeadersMiddleware, devtools],
  });
}
