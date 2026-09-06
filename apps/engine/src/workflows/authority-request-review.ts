import { SENSITIVE_KEY_PATTERN, scrubSecrets } from "@shared/redaction.ts";
import { Kind, parse, print, type ValueNode, visit } from "graphql";
import type { RequestStep } from "./types.ts";

const MAX_REVIEW_CHARACTERS = 16_000;
const MASKED = "[redacted]";

function sensitive(key: string) {
  return (
    SENSITIVE_KEY_PATTERN.test(key) || /^(?:set-cookie|cookie|private_key|master_key)$/i.test(key)
  );
}

function graphqlReview(graphql: RequestStep["graphql"]) {
  if (!graphql) return { value: null, omitted: false };
  if (graphql.query.length > MAX_REVIEW_CHARACTERS) return { value: MASKED, omitted: true };
  try {
    const document = parse(graphql.query, { noLocation: true, maxTokens: 10_000 });
    const secretVariables = new Set<string>();
    const collect = (value: ValueNode) =>
      visit(value, {
        Variable(node) {
          secretVariables.add(node.name.value);
        },
      });
    visit(document, {
      Argument(node) {
        if (sensitive(node.name.value)) collect(node.value);
      },
      ObjectField(node) {
        if (sensitive(node.name.value)) collect(node.value);
      },
    });
    const maskedValue = { kind: Kind.STRING, value: MASKED } as const;
    const safe = visit(document, {
      Argument(node) {
        if (sensitive(node.name.value)) return { ...node, value: maskedValue };
        return undefined;
      },
      ObjectField(node) {
        if (sensitive(node.name.value)) return { ...node, value: maskedValue };
        return undefined;
      },
      VariableDefinition(node) {
        if (
          node.defaultValue &&
          (sensitive(node.variable.name.value) || secretVariables.has(node.variable.name.value))
        )
          return { ...node, defaultValue: maskedValue };
        return undefined;
      },
    });
    const variables = Object.fromEntries(
      Object.entries(graphql.variables ?? {}).map(([key, value]) => [
        key,
        secretVariables.has(key) ? MASKED : value,
      ]),
    );
    return { value: { ...graphql, query: print(safe), variables }, omitted: false };
  } catch {
    // Malformed/oversized documents must not fall back to an unredacted string.
    return { value: MASKED, omitted: true };
  }
}

/** Projection only. Never mutate the exact request used for hashing or dispatch. */
function maskSecretFields(value: unknown, depth = 0): unknown {
  if (depth >= 12) return "[depth-exceeded]";
  if (Array.isArray(value)) return value.map((item) => maskSecretFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitive(key) ? MASKED : maskSecretFields(child, depth + 1),
    ]),
  );
}

export function authorityRequestReview(step: RequestStep) {
  const graphql = graphqlReview(step.graphql);
  const urlQuery: Record<string, string[]> = Object.create(null);
  try {
    // Only authored query parameters are projected; never expose URL userinfo.
    const url = new URL(step.path ?? step.url ?? "/", "https://review.invalid");
    for (const [key, value] of url.searchParams) {
      urlQuery[key] ??= [];
      urlQuery[key].push(value);
    }
  } catch {
    // Target eligibility is decided by effect resolution, not this display helper.
  }
  const source = {
    query: step.query ?? null,
    url_query: urlQuery,
    body: step.body ?? null,
    graphql: graphql.value,
    // Custom headers can carry opaque credentials under arbitrary names.
    header_names: Object.keys(step.headers ?? {}).sort(),
    header_values_omitted: Object.keys(step.headers ?? {}).length > 0,
    xml_payload_omitted: Boolean(step.xml),
  };
  const json = JSON.stringify(
    scrubSecrets(maskSecretFields(source), { promptKeys: false }),
    null,
    2,
  );
  return {
    redacted_request_json: json.slice(0, MAX_REVIEW_CHARACTERS),
    request_review_truncated:
      json.length > MAX_REVIEW_CHARACTERS || json.includes("[depth-exceeded]"),
    opaque_payload_omitted: Boolean(step.xml || step.sql || step.s3 || step.mcp || graphql.omitted),
  };
}
