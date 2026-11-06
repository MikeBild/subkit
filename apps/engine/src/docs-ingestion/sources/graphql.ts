import { assertPageSize, consumeBytes, recordSpecFetched } from "../budgets.ts";
import { byteLen } from "../chunker.ts";
import { readBoundedText } from "../read-response.ts";
import type { BudgetState, RawChunk } from "../types.ts";

const INTROSPECTION_QUERY = `
{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields {
        name
        description
        args { name description type { kind name ofType { kind name } } }
        type { kind name ofType { kind name } }
      }
      enumValues { name description }
      interfaces { name }
      possibleTypes { name }
    }
  }
}`.replace(/\s+/g, " ");

interface IntrospectionField {
  name: string;
  description?: string | null;
  args?: Array<{
    name: string;
    description?: string | null;
    type: IntrospectionTypeRef;
  }>;
  type: IntrospectionTypeRef;
}

interface IntrospectionTypeRef {
  kind: string;
  name?: string | null;
  ofType?: IntrospectionTypeRef | null;
}

interface IntrospectionType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: IntrospectionField[] | null;
  enumValues?: Array<{ name: string; description?: string | null }> | null;
  interfaces?: Array<{ name: string }> | null;
  possibleTypes?: Array<{ name: string }> | null;
}

interface IntrospectionSchema {
  queryType?: { name: string } | null;
  mutationType?: { name: string } | null;
  subscriptionType?: { name: string } | null;
  types: IntrospectionType[];
}

interface GraphQLIngestResult {
  uri: string;
  raw_bytes: number;
  chunks: RawChunk[];
}

function renderTypeRef(ref: IntrospectionTypeRef | null | undefined): string {
  if (!ref) return "Unknown";
  if (ref.kind === "NON_NULL") return `${renderTypeRef(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${renderTypeRef(ref.ofType)}]`;
  return ref.name ?? "Unknown";
}

function renderField(f: IntrospectionField): string {
  const args =
    f.args && f.args.length > 0
      ? `(${f.args.map((a) => `${a.name}: ${renderTypeRef(a.type)}`).join(", ")})`
      : "";
  const desc = f.description ? `\n  // ${f.description}` : "";
  return `  ${f.name}${args}: ${renderTypeRef(f.type)}${desc}`;
}

export function chunkGraphQLSchema(schema: IntrospectionSchema): RawChunk[] {
  const out: RawChunk[] = [];
  const queryRoot = schema.queryType?.name ?? "Query";
  const mutationRoot = schema.mutationType?.name ?? null;
  const subRoot = schema.subscriptionType?.name ?? null;

  out.push({
    title: "GraphQL schema overview",
    path: "schema",
    content: [
      "# GraphQL schema",
      `query root: ${queryRoot}`,
      mutationRoot ? `mutation root: ${mutationRoot}` : "",
      subRoot ? `subscription root: ${subRoot}` : "",
      `types: ${schema.types.length}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  for (const t of schema.types) {
    if (!t.name || t.name.startsWith("__")) continue;
    if (t.kind === "OBJECT" || t.kind === "INTERFACE" || t.kind === "INPUT_OBJECT") {
      const fields = (t.fields ?? []).map(renderField).join("\n");
      const interfaces =
        t.interfaces && t.interfaces.length > 0
          ? `\nimplements: ${t.interfaces.map((i) => i.name).join(", ")}`
          : "";
      out.push({
        title: `${t.kind.toLowerCase()}: ${t.name}`,
        path: `types.${t.name}`,
        content: [
          `# ${t.kind.toLowerCase()} ${t.name}`,
          t.description ?? "",
          interfaces,
          fields ? `\nfields:\n${fields}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    } else if (t.kind === "ENUM") {
      const values = (t.enumValues ?? []).map((v) => `  ${v.name}`).join("\n");
      out.push({
        title: `enum: ${t.name}`,
        path: `types.${t.name}`,
        content: [`# enum ${t.name}`, t.description ?? "", values].filter(Boolean).join("\n"),
      });
    } else if (t.kind === "UNION") {
      const members = (t.possibleTypes ?? []).map((p) => p.name).join(" | ");
      out.push({
        title: `union: ${t.name}`,
        path: `types.${t.name}`,
        content: [`# union ${t.name}`, t.description ?? "", members].filter(Boolean).join("\n"),
      });
    } else if (t.kind === "SCALAR") {
      out.push({
        title: `scalar: ${t.name}`,
        path: `types.${t.name}`,
        content: [`# scalar ${t.name}`, t.description ?? ""].filter(Boolean).join("\n"),
      });
    }
  }

  for (const rootName of [queryRoot, mutationRoot, subRoot]) {
    if (!rootName) continue;
    const rootType = schema.types.find((t) => t.name === rootName);
    if (!rootType?.fields) continue;
    const opKind =
      rootName === queryRoot ? "query" : rootName === mutationRoot ? "mutation" : "subscription";
    for (const op of rootType.fields) {
      out.push({
        title: `${opKind}: ${op.name}`,
        path: `operations.${opKind}.${op.name}`,
        content: [`# ${opKind} ${op.name}`, op.description ?? "", renderField(op)]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }

  return out;
}

export async function fetchIntrospection(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ body: string; bytes: number; schema: IntrospectionSchema }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!res.ok) throw new Error(`graphql introspection failed: ${res.status}`);
  const body = await readBoundedText(res);
  const bytes = byteLen(body);
  assertPageSize(bytes);
  let parsed: { data?: { __schema?: IntrospectionSchema }; errors?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `graphql introspection parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.errors) {
    throw new Error(`graphql introspection returned errors: ${JSON.stringify(parsed.errors)}`);
  }
  if (!parsed.data?.__schema) {
    throw new Error("graphql introspection: response missing data.__schema");
  }
  return { body, bytes, schema: parsed.data.__schema };
}

export async function ingestGraphQLIntrospection(
  url: string,
  state: BudgetState,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphQLIngestResult> {
  const fetched = await fetchIntrospection(url, fetchImpl);
  consumeBytes(state, fetched.bytes);
  recordSpecFetched(state);
  const chunks = chunkGraphQLSchema(fetched.schema);
  return { uri: url, raw_bytes: fetched.bytes, chunks };
}
