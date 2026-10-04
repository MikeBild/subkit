import { describe, expect, test } from "bun:test";
import { classifyGraphqlSchemaError } from "../../connectors/drivers/graphql-retry-classify.ts";
import type { RequestMeta } from "../../execution/types.ts";
import { graphqlEndpointKey } from "../../schema-versions/service.ts";
import { classifyPatch } from "../classifier.ts";
import { analyzeStepFailure } from "../drift-detector.ts";
import { endpointKeyFromRequestMeta } from "../step-snapshot.ts";

const CONNECTOR = {
  step_key: "fetch",
  connector_id: "00000000-0000-0000-0000-000000000000",
  connector_slug: "stub",
  driver: "graphql",
  requested_environment: "dev" as const,
  resolved_environment: "dev" as const,
  auth_method: "none" as const,
  base_url: null,
};

describe("classifyGraphqlSchemaError", () => {
  test("graphql-java FieldUndefined message is schema-shaped with the failing field", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [
        {
          message:
            "Validation error of type FieldUndefined: Field 'chargers' in type 'Query' is undefined @ 'chargers'",
        },
      ],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBe("chargers");
  });

  test("custom no-resolver message is schema-shaped with the qualified field", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [
        { message: "[NOT_IMPLEMENTED] no resolver for Query.chargers (op: Query.chargers)" },
      ],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBe("chargers");
  });

  test("structured classification (errorType) is authoritative", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ errorType: "ValidationError", message: "boom" }],
    });
    expect(verdict.schema_shaped).toBe(true);
  });

  test("transient throttle errors are NOT schema-shaped", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ errorType: "ThrottlingException", message: "Rate exceeded" }],
    });
    expect(verdict.schema_shaped).toBe(false);
  });

  test("auth errors are NOT schema-shaped", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ message: "Unauthorized: token expired" }],
    });
    expect(verdict.schema_shaped).toBe(false);
  });
});

describe("drift-detector: graphql_schema_error → endpoint_contract", () => {
  const failingStep = {
    id: "step-1",
    kind: "request",
    status: "failed",
    error: {
      code: "graphql_error",
      message:
        "graphql response returned errors: Validation error of type FieldUndefined: Field 'chargers' in type 'Query' is undefined",
      kind: "graphql_schema_error",
      details: {
        operation_name: "ListChargers",
        messages: ["Validation error of type FieldUndefined: Field 'chargers' ..."],
        root_field: "chargers",
      },
    },
    request_meta: {
      driver: "graphql",
      method: "POST",
      status: 200,
      operation_name: "ListChargers",
      connector: CONNECTOR,
    } as RequestMeta,
  };

  test("maps to endpoint_contract severity=removed with the failing root field", () => {
    const signal = analyzeStepFailure(failingStep, null);
    expect(signal?.kind).toBe("endpoint_contract");
    if (signal?.kind === "endpoint_contract") {
      expect(signal.severity).toBe("removed");
      expect(signal.request.path).toBe("chargers");
      expect(signal.request.method).toBe("POST");
    }
  });

  test("the resulting signal classifies unsafe — never auto-applied", () => {
    const signal = analyzeStepFailure(failingStep, null);
    expect(signal).not.toBeNull();
    const decision = classifyPatch(
      {
        kind: "endpoint_path",
        step_id: "step-1",
        description: "rewrite the removed root field",
        patch: { path: "/steps/0/graphql/query", value: "query { allChargers { id } }" },
      } as never,
      signal,
    );
    expect(decision.classification).toBe("unsafe");
  });

  test("falls back to the operation name when no root field parsed", () => {
    const signal = analyzeStepFailure(
      {
        ...failingStep,
        error: {
          ...failingStep.error,
          details: { operation_name: "ListChargers", messages: ["opaque"], root_field: null },
        },
      },
      null,
    );
    expect(signal?.kind).toBe("endpoint_contract");
    if (signal?.kind === "endpoint_contract") {
      expect(signal.request.path).toBe("ListChargers");
    }
  });
});

describe("endpoint keys stay in sync between recording and repair", () => {
  test("graphqlEndpointKey is operation-aware", () => {
    expect(graphqlEndpointKey("ListChargers")).toBe("POST /graphql#ListChargers");
    expect(graphqlEndpointKey("")).toBe("POST /graphql#anonymous");
  });

  test("endpointKeyFromRequestMeta derives the same graphql key", () => {
    const meta: RequestMeta = {
      driver: "graphql",
      method: "POST",
      status: 200,
      operation_name: "ListChargers",
      connector: CONNECTOR,
    };
    expect(endpointKeyFromRequestMeta(meta)).toBe(graphqlEndpointKey("ListChargers"));
  });

  test("http meta derives method + pathname", () => {
    const meta: RequestMeta = {
      driver: "http",
      method: "GET",
      url: "https://api.example.com/v2/users?page=2",
      connector: CONNECTOR,
    };
    expect(endpointKeyFromRequestMeta(meta)).toBe("GET /v2/users");
  });

  test("s3 meta mirrors the driver's record key", () => {
    const meta: RequestMeta = {
      driver: "s3",
      method: "LIST",
      status: 403,
      prefix: "reports/",
      connector: CONNECTOR,
    };
    expect(endpointKeyFromRequestMeta(meta)).toBe("S3 LIST reports/");
  });

  test("meta without an anchor returns null", () => {
    expect(endpointKeyFromRequestMeta(null)).toBeNull();
    const meta: RequestMeta = {
      driver: "graphql",
      method: "POST",
      status: 200,
      connector: CONNECTOR,
    };
    expect(endpointKeyFromRequestMeta(meta)).toBeNull();
  });
});
