import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  fetchGraphQLIntrospection,
  fetchOpenApiSpec,
  OPENAPI_SPEC_MAX_BYTES,
  readOpenApiSpecBody,
  SpecFetchError,
} from "../spec-fetchers.ts";

let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  fetchSpy = mock<typeof fetch>();
});

// Driver-fetch seam: the code under test reads getDriverFetch(), not
// globalThis — run each body under the seam's explicit wrapper (the
// override must scope the body itself; an enterWith-from-beforeEach
// binding did not propagate into test bodies under bun).
function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

describe("fetchOpenApiSpec — SSRF guard", () => {
  test("rejects localhost", async () => {
    await expect(fetchOpenApiSpec("http://localhost/openapi.json")).rejects.toThrow(SpecFetchError);
  });

  test("rejects 127.0.0.1", async () => {
    await expect(fetchOpenApiSpec("http://127.0.0.1/openapi.json")).rejects.toThrow(SpecFetchError);
  });

  test("rejects 10.x RFC-1918 address", async () => {
    await expect(fetchOpenApiSpec("http://10.0.0.1/openapi.json")).rejects.toThrow(SpecFetchError);
  });

  test("rejects 192.168.x address", async () => {
    await expect(fetchOpenApiSpec("http://192.168.1.1/openapi.json")).rejects.toThrow(
      SpecFetchError,
    );
  });

  test("rejects 169.254.169.254 (metadata endpoint)", async () => {
    await expect(fetchOpenApiSpec("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      SpecFetchError,
    );
  });

  test("SSRF error carries the blocked url", async () => {
    let caught: SpecFetchError | null = null;
    try {
      await fetchOpenApiSpec("http://localhost/openapi.json");
    } catch (e) {
      if (e instanceof SpecFetchError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.url).toBe("http://localhost/openapi.json");
    expect(caught!.status).toBeNull();
  });
});

describe("fetchOpenApiSpec — invalid URL", () => {
  test("throws on completely invalid URL", async () => {
    await expect(fetchOpenApiSpec("not-a-url")).rejects.toThrow();
  });
});

describe("fetchOpenApiSpec — size budget via mocked fetch", () => {
  test("uses an exact 50 MiB byte budget", () => {
    expect(OPENAPI_SPEC_MAX_BYTES).toBe(52_428_800);
  });

  seamTest("accepts a valid response above the former 8 MiB budget", async () => {
    const bigBuffer = new ArrayBuffer(12 * 1024 * 1024);
    fetchSpy.mockResolvedValue(
      new Response(bigBuffer, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await fetchOpenApiSpec("https://external.api.example.com/openapi.json");
    expect(new TextEncoder().encode(result.content).byteLength).toBe(12 * 1024 * 1024);
  });

  seamTest("accepts small content within the budget", async () => {
    const smallContent = JSON.stringify({ openapi: "3.0.0", paths: {} });
    const encoder = new TextEncoder();
    fetchSpy.mockResolvedValue(
      new Response(encoder.encode(smallContent), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await fetchOpenApiSpec("https://external.api.example.com/openapi.json");
    expect(result.content).toBe(smallContent);
    expect(result.fetched_from).toBe("https://external.api.example.com/openapi.json");
  });

  seamTest("throws SpecFetchError on non-2xx response", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(fetchOpenApiSpec("https://external.api.example.com/missing.json")).rejects.toThrow(
      SpecFetchError,
    );
  });
});

describe("readOpenApiSpecBody — streaming size enforcement", () => {
  test("accepts a body exactly at an injected cap", async () => {
    const res = new Response(new Uint8Array(1024).fill(65));
    const content = await readOpenApiSpecBody(res, "https://api.example.com/openapi.json", 1024);
    expect(content).toHaveLength(1024);
  });

  test("rejects Content-Length above 50 MiB before reading the body", async () => {
    let readAttempted = false;
    const res = new Response(null, {
      status: 200,
      headers: { "content-length": String(OPENAPI_SPEC_MAX_BYTES + 1) },
    });
    Object.defineProperty(res, "arrayBuffer", {
      value: async () => {
        readAttempted = true;
        return new ArrayBuffer(0);
      },
    });

    await expect(readOpenApiSpecBody(res, "https://api.example.com/openapi.json")).rejects.toThrow(
      "OpenAPI spec exceeds 50 MiB",
    );
    expect(readAttempted).toBe(false);
  });

  test("cancels a chunked stream as soon as an injected cap is exceeded", async () => {
    let chunk = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        controller.enqueue(new Uint8Array(700).fill(65));
        if (chunk === 3) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream);

    await expect(
      readOpenApiSpecBody(res, "https://api.example.com/openapi.json", 1024),
    ).rejects.toThrow(SpecFetchError);
    expect(cancelled).toBe(true);
  });
});

describe("fetchGraphQLIntrospection — SSRF guard", () => {
  test("rejects private host", async () => {
    await expect(fetchGraphQLIntrospection("http://10.0.0.5/graphql")).rejects.toThrow(
      SpecFetchError,
    );
  });
});

describe("fetchGraphQLIntrospection — mocked fetch", () => {
  seamTest("throws when response has no data field", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "not found" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      fetchGraphQLIntrospection("https://external.api.example.com/graphql"),
    ).rejects.toThrow(SpecFetchError);
  });

  seamTest("throws SpecFetchError on non-2xx status", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(
      fetchGraphQLIntrospection("https://external.api.example.com/graphql"),
    ).rejects.toThrow(SpecFetchError);
  });
});
