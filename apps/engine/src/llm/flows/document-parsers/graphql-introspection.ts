// GraphQL introspection-response parser.
// Accepts the JSON envelope returned by fetchGraphQLIntrospection (shape:
// { data: IntrospectionQuery }) and uses `buildClientSchema` from the
// `graphql` package to walk the schema — more reliable than the hand-rolled
// parser in graphql.ts which targets SDL strings.

import { buildClientSchema, type IntrospectionQuery } from "graphql";
import type { EndpointSpec } from "../document-analysis.ts";

export function parseGraphQLIntrospection(content: string): EndpointSpec[] {
  let parsed: { data: IntrospectionQuery };
  try {
    parsed = JSON.parse(content) as { data: IntrospectionQuery };
  } catch (e) {
    throw new Error(`invalid GraphQL introspection JSON: ${String(e)}`);
  }
  if (!parsed.data) {
    throw new Error("introspection JSON missing `data` root");
  }
  const schema = buildClientSchema(parsed.data);
  const endpoints: EndpointSpec[] = [];

  const queryType = schema.getQueryType();
  if (queryType) {
    for (const [name, field] of Object.entries(queryType.getFields())) {
      endpoints.push({
        path: `/graphql#Query.${name}`,
        method: "POST",
        description: field.description ?? `Query ${name}`,
        expected_statuses: [200],
        idempotent: true,
      });
    }
  }

  const mutationType = schema.getMutationType();
  if (mutationType) {
    for (const [name, field] of Object.entries(mutationType.getFields())) {
      endpoints.push({
        path: `/graphql#Mutation.${name}`,
        method: "POST",
        description: field.description ?? `Mutation ${name}`,
        expected_statuses: [200],
        idempotent: false,
      });
    }
  }

  return endpoints;
}
