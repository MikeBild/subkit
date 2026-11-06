import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { RunResponseSchema } from "../routes/executions/schemas.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let upstream: MockServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("execution-draft-parity");
  upstream = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { name: "Ada", token: "secret-1", ok: true });
  });
});

afterAll(async () => {
  await upstream.close();
  await ctx.cleanup();
});

function send(path: string, body: Record<string, unknown>) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.apiKey}` },
    body: JSON.stringify(body),
  });
}

function definition(name: string, fields: Record<string, unknown>) {
  return {
    name,
    steps: [{ id: "read", kind: "request", method: "GET", url: `${upstream.baseUrl}/profile` }],
    ...fields,
  };
}

async function savedAndDraftRuns(name: string, fields: Record<string, unknown>) {
  const def = definition(name, fields);
  const created = await send("/v1/workflows", def);
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const saved = await send("/v1/executions", {
    source: "saved",
    workflow_id: id,
    hold_writes: true,
  });
  const draft = await send("/v1/executions", { source: "draft", definition: def });
  expect(saved.status).toBe(200);
  expect(draft.status).toBe(200);
  return {
    saved: RunResponseSchema.parse(await saved.json()),
    draft: RunResponseSchema.parse(await draft.json()),
  };
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { code?: unknown }).code : error;
}

function definitionErrors(details: unknown): string[] {
  const shaped = details as {
    fieldErrors?: { definition?: string[] };
    details?: { fieldErrors?: { definition?: string[] } } | { path: string; message: string }[];
  };
  if (Array.isArray(shaped.details)) {
    return shaped.details.map((issue) => `${issue.path}: ${issue.message}`);
  }
  return shaped.fieldErrors?.definition ?? shaped.details?.fieldErrors?.definition ?? [];
}

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

describe("HTTP draft runs behave like the saved workflow", () => {
  test("a draft applies the workflow response filters", async () => {
    const runs = await savedAndDraftRuns("Filtered profile", {
      response_filters: [{ target: "KEYS", action: "REMOVE", pattern: "^token$" }],
    });
    expect(runs.saved.status).toBe("succeeded");
    expect(runs.saved.output).toEqual({ name: "Ada", ok: true });
    expect(runs.draft.status).toBe(runs.saved.status);
    expect(runs.draft.output).toEqual(runs.saved.output);
  });

  test("a draft applies the workflow output transform", async () => {
    const runs = await savedAndDraftRuns("Transformed profile", {
      output_transform: '{"greeting": "Hello " & name}',
    });
    expect(runs.saved.status).toBe("succeeded");
    expect(runs.saved.output).toEqual({ greeting: "Hello Ada" });
    expect(runs.draft.status).toBe(runs.saved.status);
    expect(runs.draft.output).toEqual(runs.saved.output);
  });

  test("a draft applies the workflow validation expression", async () => {
    const runs = await savedAndDraftRuns("Validated profile", {
      validation_expression: "ok = false",
    });
    expect(runs.saved.status).toBe("failed");
    expect(errorCode(runs.saved.error)).toBe("validation_failed");
    expect(runs.draft.status).toBe(runs.saved.status);
    expect(errorCode(runs.draft.error)).toBe(errorCode(runs.saved.error));
  });

  for (const invalid of [
    {
      field: "response_filters",
      value: { response_filters: [{ target: "KEYS", action: "DROP", pattern: "^token$" }] },
    },
    { field: "product_id", value: { product_id: "Not A Product" } },
    { field: "execution_guards", value: { execution_guards: { input_bytes: { name: 0 } } } },
    { field: "caller_erasure", value: { caller_erasure: "on_success" } },
    { field: "output_transform", value: { output_transform: "{" } },
    { field: "validation_expression", value: { validation_expression: "(((" } },
    { field: "output_transform_function", value: { output_transform_function: "" } },
    { field: "validation_function", value: { validation_function: "" } },
  ]) {
    test(`a draft with an invalid ${invalid.field} is refused like a save`, async () => {
      const def = definition(`Invalid ${invalid.field}`, invalid.value);
      const save = await send("/v1/workflows", def);
      const draft = await send("/v1/executions", { source: "draft", definition: def });
      expect(save.status).toBe(400);
      expect(draft.status).toBe(400);
      const saveBody = (await save.json()) as ErrorBody;
      const draftBody = (await draft.json()) as ErrorBody;
      expect(draftBody.code).toBe(saveBody.code);
      const saveErrors = ((saveBody.details as { errors?: string[] }).errors ?? []).join("\n");
      expect(saveErrors).toContain(invalid.field);
      const draftErrors = definitionErrors(draftBody.details);
      expect(draftErrors.length).toBeGreaterThan(0);
      for (const message of draftErrors) expect(saveErrors).toContain(message);
    });
  }

  test("a draft for a product caller refuses a caller the saved workflow refuses", async () => {
    const def = definition("Product profile", {
      product_id: "profile-app",
      required_caller_kind: "user",
    });
    const created = await send("/v1/workflows", def);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const saved = await send("/v1/executions", {
      source: "saved",
      workflow_id: id,
      hold_writes: true,
    });
    const draft = await send("/v1/executions", { source: "draft", definition: def });
    expect(saved.status).toBe(403);
    expect(draft.status).toBe(saved.status);
    expect(((await draft.json()) as ErrorBody).code).toBe(((await saved.json()) as ErrorBody).code);
  });
});
