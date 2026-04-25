import { describe, expect, test } from "bun:test";
import { rerankSearchHits } from "../search-ranking.ts";

describe("rerankSearchHits", () => {
  const candidates = [
    {
      id: "op",
      document_id: "doc-1",
      title: "POST /v1/customers",
      path: "/v1/customers",
      content: "Create a customer. Returns the created customer resource.",
      snippet: "Create a customer",
      rank: 0.4,
    },
    {
      id: "auth",
      document_id: "doc-1",
      title: "Authentication",
      path: "/auth",
      content: "Use a bearer token in the Authorization header for every request.",
      snippet: "Use a bearer token",
      rank: 0.45,
    },
    {
      id: "schema",
      document_id: "doc-1",
      title: "Customer schema",
      path: "/schemas/customer",
      content: "Fields: id, email, status, created_at. Response schema details.",
      snippet: "Fields: id, email",
      rank: 0.35,
    },
  ];

  test("prioritizes operation queries against endpoint chunks", () => {
    const hits = rerankSearchHits("create customer", candidates, 3);
    expect(hits[0]?.id).toBe("op");
    expect(hits[0]?.match_type).toBe("operation");
  });

  test("prioritizes auth queries against auth chunks", () => {
    const hits = rerankSearchHits("bearer token authorization", candidates, 3);
    expect(hits[0]?.id).toBe("auth");
    expect(hits[0]?.match_type).toBe("auth");
  });

  test("prioritizes schema queries against field-heavy chunks", () => {
    const hits = rerankSearchHits("customer fields response schema", candidates, 3);
    expect(hits[0]?.id).toBe("schema");
    expect(hits[0]?.match_type).toBe("schema");
  });
});
