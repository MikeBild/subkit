import { parsePlaceholders } from "../../../llm/substitution/parser.ts";
import {
  type ResolverContext,
  resolvePlaceholders,
  resolvePlaceholdersTypePreserving,
  type Unresolved,
} from "../../../llm/substitution/resolver.ts";

export type QueryValue = string | number | boolean;

export interface ResolvedQuery {
  value: Record<string, QueryValue>;
  unresolved: Unresolved[];
  omitted: string[];
}

const isWholePlaceholder = (raw: unknown): raw is string => {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("${") || trimmed.startsWith("$${") || !trimmed.endsWith("}"))
    return false;
  const { tokens, errors } = parsePlaceholders(trimmed);
  return errors.length === 0 && tokens.length === 1 && tokens[0]!.span.end === trimmed.length;
};

const isQueryPrimitive = (value: unknown): value is QueryValue =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Resolves request query placeholders; a whole-value placeholder resolving to null/undefined drops its key (#541). */
export async function resolveRequestQuery(
  query: Record<string, unknown>,
  ctx: ResolverContext,
): Promise<ResolvedQuery> {
  const resolvedQuery: ResolvedQuery = { value: {}, unresolved: [], omitted: [] };
  for (const [queryKey, rawValue] of Object.entries(query)) {
    if (isWholePlaceholder(rawValue)) {
      const native = await resolvePlaceholdersTypePreserving(rawValue, ctx);
      if (native.unresolved.length === 0) {
        const nativeValue = native.value as unknown;
        if (nativeValue === null || nativeValue === undefined) {
          resolvedQuery.omitted.push(queryKey);
          continue;
        }
        if (isQueryPrimitive(nativeValue)) {
          resolvedQuery.value[queryKey] = nativeValue;
          continue;
        }
      }
    }
    const stringified = await resolvePlaceholders(rawValue, ctx);
    resolvedQuery.unresolved.push(...stringified.unresolved);
    resolvedQuery.value[queryKey] = stringified.value as QueryValue;
  }
  return resolvedQuery;
}
