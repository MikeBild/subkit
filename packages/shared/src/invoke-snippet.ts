// The copy-paste snippet that runs a saved workflow over HTTP — the ONE
// renderer behind `sk workflows invoke-snippet` and the engine's
// `GET /v1/workflows/{id}/invocation`, so the terminal and the workflow page
// hand out the same call for the same inputs.
//
// The call targets `POST /v1/executions`, the route every saved run goes
// through. Two things a caller cannot guess are always spelled out:
//
//   - `x-subkit-environment`. The engine runs in development when the header
//     is absent, so a snippet without it silently runs somewhere else than the
//     reader meant.
//   - the API key as a `$SK_API_KEY` placeholder. A real key is never printed.
//
// Pure and primitive-typed: no I/O, no clock, nothing from `apps/*`.

export const INVOKE_SNIPPET_LANGUAGES = ["curl", "node", "python"] as const;
export type InvokeSnippetLanguage = (typeof INVOKE_SNIPPET_LANGUAGES)[number];

export const INVOKE_ENVIRONMENTS = ["dev", "prod"] as const;
export type InvokeEnvironment = (typeof INVOKE_ENVIRONMENTS)[number];

/** The route a saved run is posted to, relative to the engine's base URL. */
export const INVOKE_RUN_PATH = "/v1/executions";

/** Header names a run request carries, in the order the snippets print them. */
export const INVOKE_HEADER_NAMES = [
  "authorization",
  "x-subkit-environment",
  "content-type",
] as const;

export interface InvokeSnippetOptions {
  lang: InvokeSnippetLanguage;
  /** The engine's base URL; a trailing slash is tolerated. */
  engineUrl: string;
  workflowId: string;
  /** Where the run executes. Always printed — never left to the engine's default. */
  environment: InvokeEnvironment;
  /** The run's input; an empty object when the caller has no sample. */
  input?: Record<string, unknown>;
}

export function isInvokeSnippetLanguage(value: string): value is InvokeSnippetLanguage {
  return (INVOKE_SNIPPET_LANGUAGES as readonly string[]).includes(value);
}

export function isInvokeEnvironment(value: string): value is InvokeEnvironment {
  return (INVOKE_ENVIRONMENTS as readonly string[]).includes(value);
}

/** The absolute URL of the run route under `engineUrl`. */
export function invokeRunUrl(engineUrl: string): string {
  return `${engineUrl.replace(/\/+$/, "")}${INVOKE_RUN_PATH}`;
}

/** The request body of a saved run. Input always travels under `input`. */
export function invokeRunBody(
  workflowId: string,
  input: Record<string, unknown> = {},
): { source: "saved"; workflow_id: string; input: Record<string, unknown> } {
  return { source: "saved", workflow_id: workflowId, input };
}

/** A JSON document inside a single-quoted shell word. */
function shellQuoted(json: string): string {
  return json.replaceAll("'", `'\\''`);
}

export function renderInvokeSnippet(options: InvokeSnippetOptions): string {
  const { lang, environment } = options;
  const url = invokeRunUrl(options.engineUrl);
  const body = invokeRunBody(options.workflowId, options.input);

  if (lang === "curl") {
    return [
      `curl -sS -X POST '${url}' \\`,
      `  -H 'authorization: Bearer '"$SK_API_KEY" \\`,
      `  -H 'x-subkit-environment: ${environment}' \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '${shellQuoted(JSON.stringify(body))}'`,
    ].join("\n");
  }

  if (lang === "node") {
    return [
      `const res = await fetch("${url}", {`,
      `  method: "POST",`,
      `  headers: {`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted verbatim into the reader's Node snippet as a template-literal placeholder.
      "    authorization: `Bearer ${process.env.SK_API_KEY}`,",
      `    "x-subkit-environment": "${environment}",`,
      `    "content-type": "application/json",`,
      `  },`,
      `  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}),`,
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
    `    "${url}",`,
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

/**
 * A JSON value as a Python literal. JSON's `true` / `false` / `null` are not
 * Python: pasted as they are, a sample input carrying one of them is a
 * `NameError` before the request is ever sent.
 */
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
