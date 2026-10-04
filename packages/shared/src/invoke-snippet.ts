export const INVOKE_SNIPPET_LANGUAGES = ["curl", "node", "python"] as const;
export type InvokeSnippetLanguage = (typeof INVOKE_SNIPPET_LANGUAGES)[number];

export const INVOKE_ENVIRONMENTS = ["dev", "prod"] as const;
export type InvokeEnvironment = (typeof INVOKE_ENVIRONMENTS)[number];

export const INVOKE_RUN_PATH = "/v1/executions";

export const INVOKE_HEADER_NAMES = [
  "authorization",
  "x-subkit-environment",
  "content-type",
] as const;

export interface InvokeSnippetOptions {
  lang: InvokeSnippetLanguage;
  engineUrl: string;
  workflowId: string;
  environment: InvokeEnvironment;
  input?: Record<string, unknown>;
}

export function isInvokeSnippetLanguage(value: string): value is InvokeSnippetLanguage {
  return (INVOKE_SNIPPET_LANGUAGES as readonly string[]).includes(value);
}

export function isInvokeEnvironment(value: string): value is InvokeEnvironment {
  return (INVOKE_ENVIRONMENTS as readonly string[]).includes(value);
}

export function invokeRunUrl(engineUrl: string): string {
  return `${engineUrl.replace(/\/+$/, "")}${INVOKE_RUN_PATH}`;
}

export function invokeRunBody(
  workflowId: string,
  input: Record<string, unknown> = {},
): { source: "saved"; workflow_id: string; input: Record<string, unknown> } {
  return { source: "saved", workflow_id: workflowId, input };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function javascriptLiteral(value: unknown, indent: string): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${inner}${javascriptLiteral(item ?? null, inner)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => {
        const name = key === "__proto__" ? `["__proto__"]` : JSON.stringify(key);
        return `${inner}${name}: ${javascriptLiteral(entry, inner)}`;
      });
    if (entries.length === 0) return "{}";
    return `{\n${entries.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function renderInvokeSnippet(options: InvokeSnippetOptions): string {
  const { lang, environment } = options;
  const url = invokeRunUrl(options.engineUrl);
  const body = invokeRunBody(options.workflowId, options.input);

  if (lang === "curl") {
    return [
      `curl -sS -X POST ${shellQuote(url)} \\`,
      `  -H 'authorization: Bearer '"$SK_API_KEY" \\`,
      `  -H 'x-subkit-environment: ${environment}' \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d ${shellQuote(JSON.stringify(body))}`,
    ].join("\n");
  }

  if (lang === "node") {
    return [
      `const res = await fetch(${JSON.stringify(url)}, {`,
      `  method: "POST",`,
      `  headers: {`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted verbatim into the reader's Node snippet as a template-literal placeholder.
      "    authorization: `Bearer ${process.env.SK_API_KEY}`,",
      `    "x-subkit-environment": "${environment}",`,
      `    "content-type": "application/json",`,
      `  },`,
      `  body: JSON.stringify(${javascriptLiteral(body, "  ")}),`,
      `});`,
      `const result = await res.json();`,
      `console.log(result);`,
    ].join("\n");
  }

  return [
    `import os`,
    `import requests`,
    ``,
    `res = requests.post(`,
    `    ${JSON.stringify(url)},`,
    `    headers={`,
    `        "authorization": f"Bearer {os.environ['SK_API_KEY']}",`,
    `        "x-subkit-environment": "${environment}",`,
    `        "content-type": "application/json",`,
    `    },`,
    `    json=${pythonLiteral(body)},`,
    `)`,
    `print(res.json())`,
  ].join("\n");
}

function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => `${JSON.stringify(key)}: ${pythonLiteral(entry)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return "None";
}
