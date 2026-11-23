export type ActionVerb = "send" | "create" | "update" | "run" | "save" | "other";

export type EffectClass =
  | "ordinary"
  | "payment"
  | "deletion"
  | "publication"
  | "permission_or_settings"
  | "account_creation"
  | "credential"
  | "unknown";

export interface ActionHints {
  readonly template?: string | null;
}

export interface BoundAction {
  readonly tool: string;
  readonly verb: ActionVerb;
  readonly verbs: readonly ActionVerb[];
  readonly effect_class: EffectClass;
  readonly target: string | null;
  readonly account: string | null;
  readonly recipients: readonly string[];
  readonly content_summary: string | null;
  readonly draft: boolean;
}

import { declaredEffect } from "./declared-effect.ts";
import {
  ACCOUNT_RESOURCE_TOKENS,
  ACCOUNT_ROUTE_TOKENS,
  DISPATCH_TOKENS,
  DRAFT_TOKENS,
  NEVER_TOKENS,
  OPERATION_VALUE_KEYS,
  ORDINARY_OPERATION_TOKENS,
  QUALIFIER_VALUE_KEYS,
  SEND_TOKENS,
  UPDATE_TOKENS,
} from "./effect-vocabulary.ts";

export const COVERABLE_NATIVE_TOOLS: ReadonlyMap<string, ActionVerb> = new Map([
  ["save_connector_draft", "save"],
]);

const CONTENT_KEYS = new Set([
  "body",
  "text",
  "message",
  "content",
  "html",
  "markdown",
  "description",
  "note",
  "notes",
  "comment",
  "summary",
  "subject",
  "title",
  "caption",
  "details",
]);

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isContentKey(key: string): boolean {
  return CONTENT_KEYS.has(foldToken(key));
}

function foldToken(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

export function nameTokens(raw: string): string[] {
  const spaced = raw.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2");
  const parts = spaced
    .split(/[^\p{L}\p{N}]+/u)
    .map(foldToken)
    .filter((part) => part.length > 0);
  const joined: string[] = [];
  for (let i = 0; i + 1 < parts.length; i++) joined.push(`${parts[i]}${parts[i + 1]}`);
  return [...parts, ...joined];
}

function keyTokens(value: unknown, depth = 0): string[] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => keyTokens(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
    ...nameTokens(key),
    ...keyTokens(nested, depth + 1),
  ]);
}

function valueTokens(value: unknown, keys: ReadonlySet<string>, depth = 0): string[] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => valueTokens(item, keys, depth + 1));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    if (typeof nested === "string" && keys.has(foldToken(key))) {
      return nested.length <= 200 ? nameTokens(nested) : [];
    }
    return valueTokens(nested, keys, depth + 1);
  });
}

function singular(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function classify(tokens: readonly string[], resourceTokens: readonly string[]): EffectClass {
  for (const [effect, words] of NEVER_TOKENS) {
    if (tokens.some((token) => words.has(token) || words.has(singular(token)))) return effect;
  }
  if (tokens.some((token) => ACCOUNT_ROUTE_TOKENS.has(token))) return "account_creation";
  if (resourceTokens.some((token) => ACCOUNT_RESOURCE_TOKENS.has(token))) {
    return "account_creation";
  }
  return "ordinary";
}

function lastResourceTokens(path: string): string[] {
  const segments = path.split("/").filter((segment) => /^[\p{L}_.-]+$/u.test(segment));
  return nameTokens(segments.at(-1) ?? "");
}

function pathOf(args: Record<string, unknown>): string {
  const raw = typeof args.path === "string" ? args.path : "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

function graphqlOperationName(body: Record<string, unknown>): string {
  const query = typeof body.query === "string" ? body.query : "";
  const named = /\bmutation\s+(\w+)/u.exec(query)?.[1] ?? "";
  const field = /\bmutation\b[^{]*\{\s*(\w+)/u.exec(query)?.[1] ?? "";
  return `${named} ${field}`;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function summarize(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

function contentSummary(payload: Record<string, unknown>): string | null {
  const direct = firstString(payload, ["subject", "title", "summary", "name"]);
  const body = firstString(payload, ["text", "body", "message", "content", "description", "html"]);
  if (direct && body) return summarize(`${direct} — ${body}`);
  return summarize(direct ?? body);
}

function connectorAction(
  tool: string,
  args: Record<string, unknown>,
  recipients: readonly string[],
  hints: ActionHints,
): BoundAction {
  const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
  const path = pathOf(args);
  const body = asObj(args.body);
  const account = firstString(args, ["connector", "connector_slug", "connector_id"]);
  const base = { tool, account, recipients, content_summary: contentSummary(body), draft: false };
  if (typeof args.sql === "string") {
    return { ...base, verb: "other", verbs: [], effect_class: "unknown", target: "SQL statement" };
  }
  const graphql = typeof body.query === "string" ? graphqlOperationName(body) : "";
  const operations = [
    ...valueTokens(body, OPERATION_VALUE_KEYS),
    ...valueTokens(asObj(args.query), OPERATION_VALUE_KEYS),
  ];
  const routeTokens = [...nameTokens(path), ...nameTokens(graphql), ...operations];
  const tokens = [
    ...routeTokens,
    ...keyTokens(body),
    ...keyTokens(asObj(args.query)),
    ...valueTokens(body, QUALIFIER_VALUE_KEYS),
    ...valueTokens(asObj(args.query), QUALIFIER_VALUE_KEYS),
  ];
  const headerTokens = keyTokens(asObj(args.headers));
  const target = `${method} ${path || "/"}`;
  const none = { ...base, verb: "other" as const, verbs: [] };
  if (method === "DELETE") return { ...none, effect_class: "deletion", target };
  if (classify(headerTokens, []) === "credential" || headerTokens.includes("cookie")) {
    return { ...none, effect_class: "credential", target };
  }
  const declared = declaredEffect(hints.template ?? null, method, path);
  const named = classify(tokens, [...lastResourceTokens(path), ...nameTokens(graphql)]);
  const recognized =
    declared === "ordinary" || routeTokens.some((token) => ORDINARY_OPERATION_TOKENS.has(token));
  const effect_class: EffectClass =
    named !== "ordinary"
      ? named
      : declared !== null && declared !== "ordinary"
        ? declared
        : recognized
          ? "ordinary"
          : "unknown";
  const draft = routeTokens.some((token) => DRAFT_TOKENS.has(token));
  const shaped = { ...base, draft, effect_class, target };
  if (method === "PUT" || method === "PATCH") {
    return { ...shaped, verb: "update", verbs: ["update"] };
  }
  if (method !== "POST") return { ...none, effect_class: "unknown", target };
  if (draft) return { ...shaped, verb: "create", verbs: ["create", "save", "send"] };
  if (routeTokens.some((token) => DISPATCH_TOKENS.has(token))) {
    return { ...shaped, verb: "send", verbs: ["send"] };
  }
  if (routeTokens.some((token) => SEND_TOKENS.has(token))) {
    return { ...shaped, verb: "send", verbs: ["send", "create"] };
  }
  if (routeTokens.some((token) => UPDATE_TOKENS.has(token))) {
    return { ...shaped, verb: "update", verbs: ["update"] };
  }
  return { ...shaped, verb: "create", verbs: ["create", "send"] };
}

function externalToolAction(
  tool: string,
  args: Record<string, unknown>,
  recipients: readonly string[],
): BoundAction {
  const tokens = nameTokens(tool.replace(/^mcp_/u, ""));
  const effect_class = classify(
    [
      ...tokens,
      ...keyTokens(args),
      ...valueTokens(args, OPERATION_VALUE_KEYS),
      ...valueTokens(args, QUALIFIER_VALUE_KEYS),
    ],
    tokens,
  );
  const draft = tokens.some((token) => DRAFT_TOKENS.has(token));
  const base = {
    tool,
    account: null,
    recipients,
    content_summary: contentSummary(args),
    target: tool,
    effect_class,
    draft,
  };
  if (tokens.some((token) => SEND_TOKENS.has(token))) {
    return { ...base, verb: "send", verbs: ["send"] };
  }
  if (tokens.some((token) => UPDATE_TOKENS.has(token) || token === "set")) {
    return { ...base, verb: "update", verbs: ["update"] };
  }
  if (tokens.some((token) => token === "create" || token === "add" || token === "new")) {
    return { ...base, verb: "create", verbs: ["create"] };
  }
  return { ...base, verb: "other", verbs: [], effect_class: "unknown" };
}

function nativeAction(
  tool: string,
  args: Record<string, unknown>,
  recipients: readonly string[],
): BoundAction {
  const verb = COVERABLE_NATIVE_TOOLS.get(tool);
  const target =
    firstString(args, ["execution_id", "workflow", "workflow_id", "connector_id", "slug", "id"]) ??
    tool;
  const credential = asObj(args).credential;
  const effect_class: EffectClass =
    verb === undefined || args.force_save === true || args.force_commit === true
      ? "unknown"
      : credential && typeof credential === "object"
        ? "credential"
        : "ordinary";
  return {
    tool,
    verb: verb ?? "other",
    verbs: verb ? [verb] : [],
    effect_class,
    target,
    account: null,
    recipients,
    content_summary: null,
    draft: false,
  };
}

export function describeBoundAction(
  tool: string,
  rawArgs: unknown,
  recipients: readonly string[] = [],
  hints: ActionHints = {},
): BoundAction {
  const args = asObj(rawArgs);
  if (tool === "call_connector") return connectorAction(tool, args, recipients, hints);
  if (tool.startsWith("mcp_")) return externalToolAction(tool, args, recipients);
  return nativeAction(tool, args, recipients);
}
