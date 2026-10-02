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

  test("the same inputs render the same bytes", () => {
    for (const lang of INVOKE_SNIPPET_LANGUAGES) {
      const options = { ...BASE, lang, environment: "prod" as const, input: { a: 1 } };
      expect(renderInvokeSnippet(options)).toBe(renderInvokeSnippet({ ...options }));
    }
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
