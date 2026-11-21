import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { wrapLanguageModel } from "ai";
import { readEnv } from "../../env.ts";
import { logger } from "../../logging/index.ts";

const REDACTED = "[REDACTED]";
const AUTH_HEADER_PATTERN =
  /^(authorization|x-api-key|api-key|x-auth-token|x-amz-security-token)$/i;

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

const isDevEnv = (): boolean => readEnv("NODE_ENV") === "development";

let cachedDevtoolsMiddleware: LanguageModelV4Middleware | null | undefined;

async function loadDevtoolsMiddleware(): Promise<LanguageModelV4Middleware | null> {
  if (cachedDevtoolsMiddleware !== undefined) return cachedDevtoolsMiddleware;
  try {
    const mod = (await import("@ai-sdk/devtools")) as {
      devToolsMiddleware: () => LanguageModelV4Middleware;
    };
    cachedDevtoolsMiddleware = mod.devToolsMiddleware();
  } catch (err) {
    cachedDevtoolsMiddleware = null;
    logger.info({
      module: "llm.devtools",
      action: "load_failed",
      msg: "@ai-sdk/devtools not loadable; continuing unwrapped",
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return cachedDevtoolsMiddleware;
}

export function __resetDevtoolsCacheForTests(): void {
  cachedDevtoolsMiddleware = undefined;
}

export async function maybeWrapForDevtools(
  model: LanguageModel | string,
): Promise<LanguageModel | string> {
  if (typeof model === "string") return model;
  if (!isDevEnv()) return model;
  if (model.specificationVersion !== "v4") return model;
  const devtools = await loadDevtoolsMiddleware();
  if (!devtools) return model;
  return wrapLanguageModel({
    model: model as LanguageModelV4,
    middleware: [scrubAuthHeadersMiddleware, devtools],
  });
}
