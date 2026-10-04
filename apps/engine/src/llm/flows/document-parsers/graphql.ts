import type { EndpointSpec } from "../document-analysis.ts";

export function parseGraphQL(content: string): EndpointSpec[] {
  if (content.trimStart().startsWith("{")) {
    try {
      const doc = JSON.parse(content) as {
        data?: {
          __schema?: {
            queryType?: unknown;
            mutationType?: unknown;
            types?: Array<{ name: string; fields?: Array<{ name: string; description?: string }> }>;
          };
        };
      };
      const schema = doc.data?.__schema;
      if (!schema) return [];

      const endpoints: EndpointSpec[] = [];
      const queryTypeName = (schema.queryType as { name?: string })?.name ?? "Query";
      const mutationTypeName = (schema.mutationType as { name?: string })?.name ?? "Mutation";

      for (const type of schema.types ?? []) {
        if (!type.fields) continue;
        const isQuery = type.name === queryTypeName;
        const isMutation = type.name === mutationTypeName;
        if (!isQuery && !isMutation) continue;
        const method = isMutation ? "POST" : "GET";
        for (const field of type.fields) {
          endpoints.push({
            path: `/graphql#${type.name}.${field.name}`,
            method,
            ...(field.description !== undefined ? { description: field.description } : {}),
            expected_statuses: [200],
            idempotent: isQuery,
          });
        }
      }
      return endpoints;
    } catch {}
  }

  const endpoints: EndpointSpec[] = [];
  const queryMatch = content.match(/type\s+Query\s*\{([^}]+)\}/s);
  const mutationMatch = content.match(/type\s+Mutation\s*\{([^}]+)\}/s);

  function parseFields(block: string, method: "GET" | "POST", isQuery: boolean): EndpointSpec[] {
    return block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => (l.split("(")[0] ?? "").split(":")[0]?.trim() ?? "")
      .filter(Boolean)
      .map((name) => ({
        path: `/graphql#${isQuery ? "Query" : "Mutation"}.${name}`,
        method,
        expected_statuses: [200],
        idempotent: isQuery,
      }));
  }

  const qBlock = queryMatch?.[1];
  const mBlock = mutationMatch?.[1];
  if (qBlock) endpoints.push(...parseFields(qBlock, "GET", true));
  if (mBlock) endpoints.push(...parseFields(mBlock, "POST", false));
  return endpoints;
}
