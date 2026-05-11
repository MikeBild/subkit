// DevTools wrap (issue #164).
//
// In non-production environments we wrap the resolved `LanguageModel` with
// `@ai-sdk/devtools`'s middleware so each `streamText`/`generateText` call
// is captured under `.devtools/` (auto-gitignored by the devtools package)
// and surfaced in the local viewer at `npx @ai-sdk/devtools`
// (port 4983). This is a developer-experience tool — never wraps in prod.
//
// We compose two middlewares: a small header scrubber (outermost) so
// devtools never sees `Authorization` / `x-api-key` / `api-key` /
// `x-auth-token` values, and the devtools middleware (innermost) which
// then writes the scrubbed call to `.devtools/generations.json`.
//
// `wrapLanguageModel` reverses the middleware array before composing, so
// the array [outer, inner] makes `outer` the user-facing wrapper —
// confirmed in node_modules/ai/dist/index.js (`reverse().reduce(...)`).

import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { wrapLanguageModel } from "ai";

const REDACTED = "[REDACTED]";
const AUTH_HEADER_PATTERN =
  /^(authorization|x-api-key|api-key|x-auth-token|x-amz-security-token)$/i;

const scrubAuthHeadersMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
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

const isDevEnv = (): boolean => process.env.NODE_ENV !== "production";

let cachedDevtoolsMiddleware: LanguageModelV3Middleware | null | undefined;

// Lazy-load the devtools middleware so production bundles never resolve
// the `@ai-sdk/devtools` package even if it stays in `devDependencies`
// after a fat install.
function loadDevtoolsMiddleware(): LanguageModelV3Middleware | null {
  if (cachedDevtoolsMiddleware !== undefined) return cachedDevtoolsMiddleware;
  try {
    // Dev-only optional load — `@ai-sdk/devtools` is a devDependency; in
    // a production-pruned `node_modules` this require throws and we fall
    // back to the unwrapped model.
    const mod = require("@ai-sdk/devtools") as {
      devToolsMiddleware: () => LanguageModelV3Middleware;
    };
    cachedDevtoolsMiddleware = mod.devToolsMiddleware();
  } catch {
    cachedDevtoolsMiddleware = null;
  }
  return cachedDevtoolsMiddleware;
}

/**
 * Wrap a resolved language model with the DevTools middleware in
 * non-production environments. Returns the model unchanged in production
 * or when the model is the mock sentinel string.
 *
 * Composition: [scrubAuthHeaders, devtools] — scrub is outermost, so
 * devtools captures call params with Authorization-style headers
 * redacted.
 */
export function maybeWrapForDevtools(model: LanguageModel | string): LanguageModel | string {
  if (typeof model === "string") return model;
  if (!isDevEnv()) return model;
  // wrapLanguageModel + the v3 middleware spec only accept LanguageModelV3.
  // Every provider subkit currently uses (anthropic/openai/google/azure/
  // bedrock/vertex/gateway) ships v3 models; the union with V2 in `ai`'s
  // public type is for backwards compatibility, not active use.
  if (model.specificationVersion !== "v3") return model;
  const devtools = loadDevtoolsMiddleware();
  if (!devtools) return model;
  return wrapLanguageModel({
    model: model as LanguageModelV3,
    middleware: [scrubAuthHeadersMiddleware, devtools],
  });
}
