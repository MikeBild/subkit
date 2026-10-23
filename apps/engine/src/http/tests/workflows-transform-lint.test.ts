import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lintJsBody } from "../../workflows/js-body-lint.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("workflows_transform_lint");
});

afterAll(async () => {
  await ctx.cleanup();
});

function headers() {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

function definition(slug: string, expression: string) {
  return {
    name: slug,
    slug,
    input_schema: { type: "object", properties: { at: { type: "string" } } },
    steps: [{ id: "shape", kind: "transform", expression }],
  };
}

const LOCALE_BODY = 'return new Date(input.input.at).toLocaleDateString("de-DE");';
const UNDECLARED_BODY = "return actionData.items;";
const VALID_BODY =
  'return { day: sk.fmt.date(input.input.at, { tz: "Europe/Berlin", pattern: "dd.MM.yyyy" }) };';

function lintMessage(expression: string): string {
  const [finding] = lintJsBody(expression);
  if (!finding) throw new Error("expected a lint finding");
  return `steps.shape.expression: ${finding.message}`;
}

async function errorsOf(res: Response): Promise<string[]> {
  const body = (await res.json()) as { details?: { errors?: string[] } };
  return body.details?.errors ?? [];
}

async function createValid(slug: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(definition(slug, VALID_BODY)),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("HTTP workflow save · JavaScript transform lint", () => {
  test("POST /v1/workflows rejects toLocaleDateString and names the sk.fmt alternative", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(definition("lint-create-locale", LOCALE_BODY)),
    });
    expect(res.status).toBe(400);
    const errors = await errorsOf(res);
    expect(errors).toEqual([lintMessage(LOCALE_BODY)]);
    expect(errors[0]).toContain("sk.fmt.date(");
  });

  test("POST /v1/workflows rejects an undeclared identifier", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(definition("lint-create-undeclared", UNDECLARED_BODY)),
    });
    expect(res.status).toBe(400);
    const errors = await errorsOf(res);
    expect(errors).toEqual([lintMessage(UNDECLARED_BODY)]);
    expect(errors[0]).toContain("'actionData' is not defined");
  });

  test("POST /v1/workflows accepts a body that only uses input and sk.*", async () => {
    await createValid("lint-create-valid");
  });

  test("PUT /v1/workflows/{id} rejects toLocaleDateString", async () => {
    const id = await createValid("lint-update-locale");
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(definition("lint-update-locale", LOCALE_BODY)),
    });
    expect(res.status).toBe(400);
    const errors = await errorsOf(res);
    expect(errors).toEqual([lintMessage(LOCALE_BODY)]);
    expect(errors[0]).toContain("sk.fmt.date(");
  });

  test("PUT /v1/workflows/{id} rejects an undeclared identifier", async () => {
    const id = await createValid("lint-update-undeclared");
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(definition("lint-update-undeclared", UNDECLARED_BODY)),
    });
    expect(res.status).toBe(400);
    expect(await errorsOf(res)).toEqual([lintMessage(UNDECLARED_BODY)]);
  });

  test("PUT /v1/workflows/{id} accepts a valid body", async () => {
    const id = await createValid("lint-update-valid");
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(
        definition("lint-update-valid", "const at = input.input.at; return { at };"),
      ),
    });
    expect(res.status).toBe(200);
  });

  test("POST /v1/workflows/validate reports the same lint error the save rejects", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/validate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(definition("lint-validate", LOCALE_BODY)),
    });
    expect(res.status).toBe(200);
    const [finding] = lintJsBody(LOCALE_BODY);
    expect(await res.json()).toEqual({
      ok: false,
      errors: [{ path: "steps.shape.expression", message: finding?.message }],
    });
  });

  test("POST /v1/workflows/drafts rejects the same body as an invalid definition", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ definition: definition("lint-draft", UNDECLARED_BODY) }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("'actionData' is not defined");
  });
});
