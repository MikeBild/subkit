import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("workflows_placeholder_destination");
});

afterAll(async () => {
  await ctx.cleanup();
});

function headers() {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

function definition(slug: string, to: string, url = "https://api.acme.com/notify") {
  return {
    name: slug,
    slug,
    steps: [{ id: "send", kind: "request", method: "POST", url, body: { to } }],
  };
}

const PLACEHOLDER_ERROR = {
  path: "steps.send.body.to",
  message:
    'placeholder destination "REPLACE_ME" — a reserved example or placeholder that cannot be delivered, even when the user typed it; ask the user for the real value with ask_user_text or ask_user_form and never fill it with a placeholder.',
};

describe("HTTP file authoring · placeholder destinations (tier tokens)", () => {
  test("POST /v1/workflows refuses a REPLACE_ME destination with 400 naming the field", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(definition("token-destination", "REPLACE_ME")),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details?: { errors?: string[] }; errors?: string[] };
    const errors = body.details?.errors ?? body.errors ?? [];
    expect(errors).toContain(`${PLACEHOLDER_ERROR.path}: ${PLACEHOLDER_ERROR.message}`);
  });

  test("POST /v1/workflows accepts an address and a host that only the LLM tier rejects", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(
        definition("example-destination", "user@example.com", "https://api.example.com/notify"),
      ),
    });
    expect(res.status).toBe(201);
  });

  test("PUT /v1/workflows/{id} applies the same token rule as create", async () => {
    const created = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(definition("update-destination", "ops@acme.com")),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(definition("update-destination", "<recipient>")),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details?: { errors?: string[] }; errors?: string[] };
    const errors = body.details?.errors ?? body.errors ?? [];
    expect(errors.some((e) => e.startsWith("steps.send.body.to: placeholder destination"))).toBe(
      true,
    );
  });

  test("POST /v1/workflows/validate keeps its contract: 200 with ok:false and the error", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/validate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(definition("validate-destination", "REPLACE_ME")),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, errors: [PLACEHOLDER_ERROR] });
  });

  test("POST /v1/workflows/drafts refuses a token destination as an invalid definition", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ definition: definition("draft-destination", "{{recipient}}") }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("steps.send.body.to");
    expect(text).toContain("{{recipient}}");
  });
});
