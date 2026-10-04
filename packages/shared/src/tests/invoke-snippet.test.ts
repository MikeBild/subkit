import { describe, expect, test } from "bun:test";
import {
  INVOKE_ENVIRONMENTS,
  INVOKE_HEADER_NAMES,
  INVOKE_SNIPPET_LANGUAGES,
  invokeRunBody,
  invokeRunUrl,
  isInvokeEnvironment,
  isInvokeSnippetLanguage,
  renderInvokeSnippet,
  shellQuote,
} from "../invoke-snippet.ts";

const WORKFLOW = "3fb5fc90-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
const BASE = { engineUrl: "https://engine.example.com", workflowId: WORKFLOW } as const;

describe("renderInvokeSnippet", () => {
  test("curl posts to the run route with the environment spelled out", () => {
    expect(renderInvokeSnippet({ ...BASE, lang: "curl", environment: "prod" })).toBe(
      [
        "curl -sS -X POST 'https://engine.example.com/v1/executions' \\",
        `  -H 'authorization: Bearer '"$SK_API_KEY" \\`,
        "  -H 'x-subkit-environment: prod' \\",
        "  -H 'content-type: application/json' \\",
        `  -d '{"source":"saved","workflow_id":"${WORKFLOW}","input":{}}'`,
      ].join("\n"),
    );
  });

  test.each(
    INVOKE_SNIPPET_LANGUAGES.flatMap((lang) =>
      INVOKE_ENVIRONMENTS.map((environment) => [lang, environment] as const),
    ),
  )("%s carries x-subkit-environment: %s", (lang, environment) => {
    const snippet = renderInvokeSnippet({ ...BASE, lang, environment });
    expect(snippet).toContain("x-subkit-environment");
    expect(snippet).toContain(environment);
    expect(snippet).toContain("https://engine.example.com/v1/executions");
    expect(snippet).toContain(WORKFLOW);
  });

  test.each([...INVOKE_SNIPPET_LANGUAGES])("%s never sends a tenant header", (lang) => {
    expect(renderInvokeSnippet({ ...BASE, lang, environment: "prod" })).not.toContain(
      "x-subkit-tenant",
    );
  });

  test.each([...INVOKE_SNIPPET_LANGUAGES])("%s names the key only as a placeholder", (lang) => {
    expect(renderInvokeSnippet({ ...BASE, lang, environment: "dev" })).toContain("SK_API_KEY");
  });

  test("a trailing slash on the engine URL does not double up", () => {
    expect(invokeRunUrl("https://engine.example.com//")).toBe(
      "https://engine.example.com/v1/executions",
    );
  });

  test("the sample input travels under `input`", () => {
    const input = { recipient_email: "ops@example.com", limit: 5 };
    expect(invokeRunBody(WORKFLOW, input)).toEqual({
      source: "saved",
      workflow_id: WORKFLOW,
      input,
    });
    const curl = renderInvokeSnippet({ ...BASE, lang: "curl", environment: "prod", input });
    expect(curl).toContain(`"input":{"recipient_email":"ops@example.com","limit":5}`);
  });

  test("an apostrophe in the input cannot end the shell word early", () => {
    const curl = renderInvokeSnippet({
      ...BASE,
      lang: "curl",
      environment: "prod",
      input: { note: "it's fine" },
    });
    expect(curl).toContain(`it'\\''s fine`);
  });

  test("python gets Python literals, not JSON ones", () => {
    const python = renderInvokeSnippet({
      ...BASE,
      lang: "python",
      environment: "prod",
      input: { dry: true, skip: false, note: null, tags: ["a", 1] },
    });
    expect(python).toContain(`"dry": True`);
    expect(python).toContain(`"skip": False`);
    expect(python).toContain(`"note": None`);
    expect(python).toContain(`"tags": ["a", 1]`);
  });

  test("node prints the body as an indented object literal", () => {
    const node = renderInvokeSnippet({ ...BASE, lang: "node", environment: "dev" });
    expect(node).toContain('await fetch("https://engine.example.com/v1/executions", {');
    expect(node).toContain('"x-subkit-environment": "dev",');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder the snippet prints.
    expect(node).toContain("authorization: `Bearer ${process.env.SK_API_KEY}`,");
    expect(node).toContain('    "source": "saved",');
  });
});

const HOSTILE_TEXT = 'it\'s $HOME `id` $(id) \\ back\\slash "quoted" \n tab\t ünï ✓ 😀';
const HOSTILE_INPUT = JSON.parse(
  JSON.stringify({ note: HOSTILE_TEXT, "we'ird $key": [true, false, null, 1.5, "'"] }).replace(
    /}$/,
    ',"__proto__":{"nested":"kept"}}',
  ),
) as Record<string, unknown>;

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated single quote");
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      const end = command.indexOf('"', i + 1);
      if (end === -1) throw new Error("unterminated double quote");
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (char === "\\") {
      i += 1;
      if (command[i] !== "\n") word = (word ?? "") + (command[i] ?? "");
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

function pythonValue(snippet: string): unknown {
  const start = snippet.indexOf("    json=") + "    json=".length;
  const literal = snippet.slice(start, snippet.lastIndexOf(",\n)"));
  const json = literal.replace(
    /"(?:[^"\\]|\\.)*"|\b(True|False|None)\b/g,
    (token, constant: string | undefined) =>
      constant === undefined
        ? token
        : ({ True: "true", False: "false", None: "null" }[constant] ?? token),
  );
  return JSON.parse(json);
}

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

async function runNodeSnippet(snippet: string): Promise<SentRequest> {
  const sent: SentRequest[] = [];
  const fetchStub = async (
    url: string,
    init: { headers: Record<string, string>; body: string },
  ) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { json: async () => ({}) };
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  await new AsyncFunction("fetch", "process", "console", snippet)(
    fetchStub,
    { env: { SK_API_KEY: "placeholder-key" } },
    { log: () => {} },
  );
  if (sent.length !== 1 || !sent[0])
    throw new Error("the snippet did not make exactly one request");
  return sent[0];
}

describe("what a pasted snippet sends", () => {
  const options = { ...BASE, environment: "prod" as const, input: HOSTILE_INPUT };
  const expected = invokeRunBody(WORKFLOW, HOSTILE_INPUT);

  test("the fixture carries __proto__ as a key, not as a prototype", () => {
    expect(Object.keys(HOSTILE_INPUT)).toContain("__proto__");
    expect(Object.getOwnPropertyDescriptor(HOSTILE_INPUT, "__proto__")?.value).toEqual({
      nested: "kept",
    });
  });

  test("curl: the shell hands curl the URL and one -d word that is the body", () => {
    const words = shellWords(renderInvokeSnippet({ ...options, lang: "curl" }));
    expect(words.slice(0, 5)).toEqual([
      "curl",
      "-sS",
      "-X",
      "POST",
      "https://engine.example.com/v1/executions",
    ]);
    const data = words[words.indexOf("-d") + 1];
    expect(words.indexOf("-d")).toBe(words.length - 2);
    expect(JSON.stringify(JSON.parse(data ?? ""))).toBe(JSON.stringify(expected));
    expect(data).toContain("$HOME `id` $(id)");
  });

  test("node: the request's body is the input, key for key", async () => {
    const sent = await runNodeSnippet(renderInvokeSnippet({ ...options, lang: "node" }));
    expect(sent.url).toBe("https://engine.example.com/v1/executions");
    expect(sent.headers).toEqual({
      authorization: "Bearer placeholder-key",
      "x-subkit-environment": "prod",
      "content-type": "application/json",
    });
    expect(JSON.stringify(sent.body)).toBe(JSON.stringify(expected));
    expect((sent.body as { input: Record<string, unknown> }).input.note).toBe(HOSTILE_TEXT);
  });

  test("node: a key named __proto__ is sent, not swallowed by the object literal", async () => {
    const sent = await runNodeSnippet(renderInvokeSnippet({ ...options, lang: "node" }));
    const input = (sent.body as { input: object }).input;
    expect(Object.keys(input)).toContain("__proto__");
    expect(Object.getOwnPropertyDescriptor(input, "__proto__")?.value).toEqual({ nested: "kept" });
  });

  test("python: the json argument denotes the input, with Python's constants", () => {
    const python = renderInvokeSnippet({ ...options, lang: "python" });
    expect(JSON.stringify(pythonValue(python))).toBe(JSON.stringify(expected));
    expect(python).toContain("[True, False, None, 1.5, ");
  });

  test.each([...INVOKE_SNIPPET_LANGUAGES])(
    "%s: an engine URL with a quote stays inside its string",
    async (lang) => {
      const engineUrl = `https://engine.example.com/a'b"c`;
      const snippet = renderInvokeSnippet({ ...BASE, engineUrl, lang, environment: "dev" });
      const url = `${engineUrl}/v1/executions`;
      if (lang === "curl") expect(shellWords(snippet)[4]).toBe(url);
      else if (lang === "node") expect((await runNodeSnippet(snippet)).url).toBe(url);
      else expect(snippet).toContain(`    ${JSON.stringify(url)},`);
    },
  );
});

describe("shellQuote", () => {
  test.each([
    "plain",
    "",
    "it's",
    "''",
    "$HOME `id` $(id)",
    'back\\slash \\\' and "double"',
    "two\nlines",
    "ünï ✓ 😀",
  ])("is read back as the one word it was given: %j", (value) => {
    expect(shellWords(`printf %s ${shellQuote(value)}`)).toEqual(["printf", "%s", value]);
  });
});

describe("vocabulary", () => {
  test("header names are the ones the snippets print", () => {
    const curl = renderInvokeSnippet({ ...BASE, lang: "curl", environment: "prod" });
    for (const name of INVOKE_HEADER_NAMES) expect(curl).toContain(`'${name}: `);
  });

  test("guards accept exactly the declared values", () => {
    expect(isInvokeSnippetLanguage("curl")).toBe(true);
    expect(isInvokeSnippetLanguage("ruby")).toBe(false);
    expect(isInvokeEnvironment("prod")).toBe(true);
    expect(isInvokeEnvironment("staging")).toBe(false);
  });
});
