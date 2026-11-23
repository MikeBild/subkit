import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type JsonObject, type JsonValue, refineOpenApiDocument } from "../openapi-document.ts";

const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });

const json = (body: JsonValue): JsonObject => ({
  content: { "application/json": { schema: body } },
});

function document(schemas: JsonObject, operation: JsonObject): JsonObject {
  return {
    openapi: "3.1.0",
    paths: { "/v1/things": { post: { responses: {}, ...operation } } },
    components: { schemas },
  };
}

function schemaAt(result: JsonObject, name: string): JsonValue | undefined {
  const components = result.components as JsonObject;
  return (components.schemas as JsonObject)[name];
}

function operationOf(result: JsonObject): JsonObject {
  const paths = result.paths as JsonObject;
  return (paths["/v1/things"] as JsonObject).post as JsonObject;
}

const Description: JsonObject = { type: "string", maxLength: 10 };

describe("refineOpenApiDocument nullable refs", () => {
  test("turns an intersection with a nullable type into a union with null", () => {
    const body: JsonObject = {
      type: "object",
      properties: { description: { allOf: [ref("Description"), { type: ["string", "null"] }] } },
    };
    const result = refineOpenApiDocument(
      document({ Description, Body: body }, { requestBody: json(ref("Body")) }),
    );
    expect(schemaAt(result, "Body")).toEqual({
      type: "object",
      properties: { description: { oneOf: [ref("Description"), { type: "null" }] } },
    });
  });

  test("keeps extra constraints of the overlay on the referenced branch", () => {
    const property: JsonObject = {
      description: "note",
      allOf: [ref("Description"), { type: ["null", "string"], minLength: 2 }],
    };
    const result = refineOpenApiDocument(
      document(
        { Description },
        { requestBody: json({ type: "object", properties: { property } }) },
      ),
    );
    const requestBody = operationOf(result).requestBody as JsonObject;
    expect(requestBody).toEqual(
      json({
        type: "object",
        properties: {
          property: {
            description: "note",
            oneOf: [{ allOf: [ref("Description"), { minLength: 2 }] }, { type: "null" }],
          },
        },
      }),
    );
  });

  test("rewrites parameters, responses and response headers", () => {
    const nullable: JsonObject = { allOf: [ref("Description"), { type: ["string", "null"] }] };
    const fixed: JsonObject = { oneOf: [ref("Description"), { type: "null" }] };
    const result = refineOpenApiDocument(
      document(
        { Description },
        {
          parameters: [
            { name: "q", in: "query", schema: nullable },
            { $ref: "#/components/parameters/x" },
          ],
          responses: {
            200: {
              ...json(nullable),
              headers: { "x-a": { schema: nullable }, "x-b": { description: "b" } },
            },
            204: { description: "empty" },
            301: "not a response",
          },
        },
      ),
    );
    const operation = operationOf(result);
    expect(operation.parameters).toEqual([
      { name: "q", in: "query", schema: fixed },
      { $ref: "#/components/parameters/x" },
    ]);
    expect(operation.responses).toEqual({
      200: { ...json(fixed), headers: { "x-a": { schema: fixed }, "x-b": { description: "b" } } },
      204: { description: "empty" },
      301: "not a response",
    });
  });

  test("leaves every other intersection untouched", () => {
    const untouched: JsonObject[] = [
      { allOf: [ref("Nullable"), { type: ["string", "null"] }] },
      { allOf: [ref("Description"), { type: ["integer", "null"] }] },
      { allOf: [ref("Description"), { type: "string" }] },
      { allOf: [ref("Description"), { description: "only metadata" }] },
      { allOf: [ref("Untyped"), { type: ["string", "null"] }] },
      { allOf: [ref("Missing"), { type: ["string", "null"] }] },
      { allOf: [{ ...ref("Description"), description: "x" }, { type: ["string", "null"] }] },
      { allOf: [ref("Description")] },
      { allOf: [{ type: "string" }, { type: ["string", "null"] }] },
      { allOf: [{ $ref: "#/components/parameters/p" }, { type: ["string", "null"] }] },
      { allOf: [ref("Description"), { type: ["string", 1] }] },
      { allOf: [ref("Description"), "text"] },
      { allOf: "not a list" },
    ];
    const schemas: JsonObject = {
      Description,
      Nullable: { type: ["string", "null"] },
      Untyped: { description: "no type" },
    };
    const body: JsonObject = {
      type: "object",
      properties: Object.fromEntries(untouched.map((s, i) => [`p${i}`, s])),
    };
    const result = refineOpenApiDocument(
      document({ ...schemas, Body: body }, { requestBody: json(ref("Body")) }),
    );
    expect(schemaAt(result, "Body")).toEqual(body);
  });
});

const Step: JsonObject = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["step"] },
    id: { type: "string" },
    on_error: { type: "string", default: "fail" },
  },
  required: ["kind", "id"],
};

const StepOutput: JsonObject = { ...Step, required: ["kind", "id", "on_error"] };

describe("refineOpenApiDocument input and output schemas", () => {
  test("splits a defaulted schema used by requests and responses", () => {
    const Definition: JsonObject = {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            oneOf: [ref("Step")],
            discriminator: {
              propertyName: "kind",
              mapping: { step: "#/components/schemas/Step", other: "#/x" },
            },
          },
        },
      },
      required: ["steps"],
    };
    const result = refineOpenApiDocument(
      document(
        { Definition, Step, Plain: { type: "string" } },
        { requestBody: json(ref("Definition")), responses: { 200: json(ref("Definition")) } },
      ),
    );
    expect(schemaAt(result, "Step")).toEqual(Step);
    expect(schemaAt(result, "Definition")).toEqual(Definition);
    expect(schemaAt(result, "StepOutput")).toEqual(StepOutput);
    expect(schemaAt(result, "DefinitionOutput")).toEqual({
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            oneOf: [ref("StepOutput")],
            discriminator: {
              propertyName: "kind",
              mapping: { step: "#/components/schemas/StepOutput", other: "#/x" },
            },
          },
        },
      },
      required: ["steps"],
    });
    expect(Object.keys((result.components as JsonObject).schemas as JsonObject)).toEqual([
      "Definition",
      "DefinitionOutput",
      "Step",
      "StepOutput",
      "Plain",
    ]);
    expect(operationOf(result).responses).toEqual({ 200: json(ref("DefinitionOutput")) });
    expect(operationOf(result).requestBody).toEqual(json(ref("Definition")));
  });

  test("marks defaulted fields present in place when only responses use the schema", () => {
    const Listing: JsonObject = {
      type: "object",
      properties: { size: { type: "integer", default: 10 }, step: ref("Step") },
    };
    const result = refineOpenApiDocument(
      document(
        { Listing, Step, Body: { type: "object", properties: { step: ref("Step") } } },
        {
          requestBody: json(ref("Body")),
          responses: {
            200: json(ref("Listing")),
            201: json({ type: "object", properties: { n: { type: "integer", default: 1 } } }),
          },
        },
      ),
    );
    expect(schemaAt(result, "Listing")).toEqual({
      type: "object",
      properties: { size: { type: "integer", default: 10 }, step: ref("StepOutput") },
      required: ["size"],
    });
    expect(schemaAt(result, "Body")).toEqual({ type: "object", properties: { step: ref("Step") } });
    expect((operationOf(result).responses as JsonObject)[201]).toEqual(
      json({ type: "object", properties: { n: { type: "integer", default: 1 } }, required: ["n"] }),
    );
  });

  test("keeps request-only schemas and already required defaults as they are", () => {
    const Query: JsonObject = {
      type: "object",
      properties: {
        limit: { type: "integer", default: 5 },
        mode: { type: "string", default: "a" },
      },
      required: ["mode", 3],
    };
    const result = refineOpenApiDocument(
      document(
        { Query, Unused: Step },
        {
          requestBody: json(ref("Query")),
          responses: {
            200: json({
              type: "object",
              properties: { mode: { type: "string", default: "a" } },
              required: ["mode"],
            }),
          },
        },
      ),
    );
    expect(schemaAt(result, "Query")).toEqual(Query);
    expect(schemaAt(result, "Unused")).toEqual(Step);
    expect((operationOf(result).responses as JsonObject)[200]).toEqual(
      json({
        type: "object",
        properties: { mode: { type: "string", default: "a" } },
        required: ["mode"],
      }),
    );
  });

  test("ignores refs to missing schemas and non-operation path entries", () => {
    const input: JsonObject = {
      openapi: "3.1.0",
      paths: {
        "/v1/a": {
          summary: "shared",
          servers: [],
          get: { responses: { 200: json(ref("Missing")) } },
          post: {
            requestBody: { description: "no content" },
            responses: { 200: { content: { "text/plain": "x" } } },
          },
        },
        "/v1/b": "not an item",
      },
    };
    const result = refineOpenApiDocument(input);
    expect(result.paths).toEqual(input.paths);
    expect(result.components).toEqual({ schemas: {} });
  });

  test("refuses to overwrite an existing output schema", () => {
    expect(() =>
      refineOpenApiDocument(
        document(
          { Step, StepOutput: { type: "string" } },
          { requestBody: json(ref("Step")), responses: { 200: json(ref("Step")) } },
        ),
      ),
    ).toThrow("OpenAPI schema StepOutput already exists");
  });
});

const names = ["A", "B", "C", "D"] as const;

const propertyArb: fc.Arbitrary<JsonObject> = fc.oneof(
  fc.constant<JsonObject>({ type: "string" }),
  fc.constant<JsonObject>({ type: "string", default: "x" }),
  fc.constantFrom(...names).map(ref),
  fc
    .constantFrom(...names)
    .map((name): JsonObject => ({ allOf: [ref(name), { type: ["object", "null"] }] })),
  fc.constantFrom(...names).map((name): JsonObject => ({ type: "array", items: ref(name) })),
);

const schemaArb: fc.Arbitrary<JsonObject> = fc
  .dictionary(fc.constantFrom("p", "q", "r"), propertyArb, { maxKeys: 3 })
  .map((properties): JsonObject => ({ type: "object", properties }));

const documentArb: fc.Arbitrary<JsonObject> = fc
  .record({
    schemas: fc.record({ A: schemaArb, B: schemaArb, C: schemaArb, D: schemaArb }),
    request: fc.option(fc.constantFrom(...names)),
    response: fc.option(fc.constantFrom(...names)),
  })
  .map(({ schemas, request, response }) =>
    document(schemas, {
      ...(request ? { requestBody: json(ref(request)) } : {}),
      responses: response ? { 200: json(ref(response)) } : {},
    }),
  );

function refsIn(value: JsonValue, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) refsIn(entry, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string")
        into.push(entry.replace("#/components/schemas/", ""));
      else refsIn(entry, into);
    }
  }
  return into;
}

describe("refineOpenApiDocument properties", () => {
  test("is idempotent", () => {
    fc.assert(
      fc.property(documentArb, (input) => {
        const once = refineOpenApiDocument(input);
        expect(refineOpenApiDocument(once)).toEqual(once);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("every ref resolves and request bodies keep their schema names", () => {
    fc.assert(
      fc.property(documentArb, (input) => {
        const result = refineOpenApiDocument(input);
        const schemas = (result.components as JsonObject).schemas as JsonObject;
        for (const name of refsIn(result)) expect(name in schemas).toBe(true);
        expect(operationOf(result).requestBody).toEqual(operationOf(input).requestBody);
        for (const name of names) expect(name in schemas).toBe(true);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});

describe("refineOpenApiDocument discriminators", () => {
  const Http: JsonObject = {
    type: "object",
    properties: { protocol: { type: "string", enum: ["http"] } },
    required: ["kind"],
  };
  const Sql: JsonObject = {
    type: "object",
    properties: { protocol: { type: "string", enum: ["sql"] } },
    required: ["kind", "protocol"],
  };
  const union = (mapping: JsonObject): JsonObject => ({
    oneOf: [ref("Http"), ref("Sql")],
    discriminator: { propertyName: "protocol", mapping },
  });

  test("drops a discriminator whose property one member may omit", () => {
    const result = refineOpenApiDocument(
      document(
        { Http, Sql, Step: union({ sql: "#/components/schemas/Sql" }) },
        { requestBody: json(ref("Step")) },
      ),
    );
    expect(schemaAt(result, "Step")).toEqual({ oneOf: [ref("Http"), ref("Sql")] });
  });

  test("keeps a discriminator every member requires", () => {
    const Strict: JsonObject = { ...Http, required: ["kind", "protocol"] };
    const step = {
      oneOf: [ref("Strict"), ref("Sql")],
      discriminator: { propertyName: "protocol" },
    };
    const result = refineOpenApiDocument(
      document({ Strict, Sql, Step: step }, { requestBody: json(ref("Step")) }),
    );
    expect(schemaAt(result, "Step")).toEqual(step);
  });
});
